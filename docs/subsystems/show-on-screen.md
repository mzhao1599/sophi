# Show on screen guide: "Show me the weather"

**For:** whoever builds or demos the assistant's `show_on_screen` tool: the cloud assistant (`services/cloud-api/src/walker/`), the Pi service and its screen state machine (`devices/pi`), the walker screen (`packages/walker-screen`) and the shared contract (`packages/contracts`).

**Status (2026-10-24, design):** the contract below is written and tested. The cloud's part is built and tested against a fake model only (see "The cloud"). Nothing else is built until this line says so.

## What she can do

She holds Talk and asks Sophi to pull something up on the walker's screen. Sophi picks the card, the walker fills it from its own data, and Sophi says it's there ("It's on your screen: 64 degrees and partly cloudy.").

| She asks | View | Where the card's data comes from |
| --- | --- | --- |
| "Show me the weather." | `weather` | One GPS fix, then Open-Meteo, from the Pi (as `get_weather`). Big temperature, the conditions, the wind, "Weather data from Open-Meteo". |
| "Show me where I am." | `location` | One GPS fix, then the reverse geocoder, from the Pi (as `get_location`). The nearest address in large type. No coordinates on screen. |
| "Show me what the sensors see." | `sensors` | The obstacle zones' latest readings, kept current while the card is up. A zone that isn't measured says so; nothing ever reads "clear". |
| "Show me Maya's message again." | `message` | Her newest caretaker message, held on the Pi. Its words never go to the model. |
| "What's connected? Show me." | `parts` | The Pi's own capability manifest: each part, its health, simulated parts marked. |

The card stays up while Sophi answers, with her reply as a caption line under it, then for `SCREEN_SHOW_MS` (30 s) after the answer ends. A Talk press, an obstacle or a newer card ends it sooner. Voice is never the only way to get the same information: each answer is spoken, captioned on the walker and shown on the owner's page.

## Why the model only picks a name

The model returns `tool_call: {name: "show_on_screen", view: "weather"}`, nothing more. Every word and number on the card is built by the Pi from its own readings and services, so no model output, and no text inside a tool result, can put words of its own on her screen. Same pattern as the walking-directions design: the Pi decides, the screen draws.

## The shared contract (written first, by the lead)

All in `packages/contracts`, validated on both sides:

1. **`ShowViewSchema`** (`walker.ts`): `weather`, `location`, `sensors`, `message`, `parts`.
2. **The tool**: `WalkerToolNameSchema` adds `show_on_screen`; `WalkerToolCallSchema` is the response's `tool_call`, where `show_on_screen` carries `view`. Its result comes back in `tool_results` like the other tools.
3. **What the walker can show now**: `DeviceTurnRequestSchema.screen = {views}`, present only while a screen page is connected to the Pi, listing the views it can fill right now (GPS connected for `weather` and `location`, obstacle sensors for `sensors`, a held message for `message`; `parts` whenever a screen is connected). Sent on continuations too. The server offers the tool only with this field, and only those views, so an older Pi (no field) never receives a `tool_call` it can't parse.
4. **The `showing` screen state** (`circle.ts`): `{card: ShowCard, caption: string | null}`, one card shape per view (`ShowCardSchema`). No coordinates, no free text. Its place in the Pi's priority order: under `listening`, over `thinking` and `answering`.
5. **`SCREEN_SHOW_MS`** (`circle.ts`): 30 s.

## The cloud (services/cloud-api)

**Built and tested (2026-10-24), against a fake model.** Not yet run against Gemini, a Pi or a screen. Code: `src/walker/assistant.ts`, `service.ts` and `hedge.ts`; the expected results are in `test/walker/EXPECTED-turns.md` ("Pulling something up on the walker's screen") and the tests in `test/walker/turn.test.ts`.

- **Offered per turn.** The JSON schema sent to the model is built for each turn (`walkerReplyJsonSchema(views)`). It offers `{name: "show_on_screen", view}`, with `view` limited to that turn's `screen.views`, only on a walker turn that carries `screen`. A walker turn without `screen` (an older Pi, or no screen page connected) and every page turn get the schema without it, so the model is never told about a card the walker can't fill. The backup model gets the same views.
- **Checked again on the server.** The reply parser accepts the contract's `WalkerToolCallSchema`, so the server sees any view the model names and refuses one the turn didn't list: the fixed line "I can't show that on this walker's screen right now." (rule `show_unavailable`), with no `tool_call`. A page turn that asks for it gets "Please use Talk on the walker for that request." (rule `device_tool_only`), as with the other device tools.
- **Context.** `screen_views` is the turn's list, or `[]` with no screen and on a page turn.
- **System prompt.** One rule for every turn: when a spoken walker turn asks to see, show, display or pull up the weather, where they are, what the sensors read, their newest message or the walker's parts on the screen, request `show_on_screen` with that view (instead of `get_weather` or `get_location`), only if it's in `screen_views`, and otherwise say it can't be shown right now. Never say something is on the screen until a `show_on_screen` result says so, then answer from it; a message's words aren't in the result and mustn't be invented; on a page turn, ask her to use Talk. The old rules stay, "clear" and "safe" included.
- **The step.** The response carries `tool_call: {name: "show_on_screen", view}` (it parses with `WalkerToolCallSchema`) and the line "Putting that on your screen.", taken from one `Record<WalkerToolName, string>` so no tool can fall through to another tool's line. Nothing is stored for the step. The loop then runs like the other device tools: the same `client_turn_id`, the same eight-call budget (`tool_limit` past it).
- **The answer.** After the result, the model's reply is the final answer, stored and spoken. After a sensors card that reply is used even when tagged `obstacles` (the fixed distance line steps aside, since the card's result is the reading she asked about), and the "clear"/"safe" check still reads it and retries once. After a weather card whose result credits Open-Meteo, the server adds " Weather data from Open-Meteo." when the model left it out, as after `get_weather`.
- **Spoken continuation.** A continuation (`original_audio: true`) now reads to the model as "spoke while holding Talk", not "typed on the walker", so the model doesn't answer a card's result with "use Talk". The same change is on the `navigation` branch.

## The Pi (devices/pi)

- **Turn requests** carry `screen.views` when the screen server has a connected page.
- **Running the tool**: build the card from local data (weather and location reuse the GPS fix and the same providers, returning structured values as well as today's sentence), put it on the screen machine's new `showing` layer, and return a short result text for the model ("Showing the weather on the screen: 64 degrees Fahrenheit with partly cloudy skies and wind around 8 miles per hour. Weather data from Open-Meteo."). The `message` result names the sender only, never the words. A failure (no GPS fix, a provider error, nothing to show) shows nothing and says why in the result.
- **The screen machine** gains the `showing` layer, ordered as in the contract, with the answer's current caption page in `caption`, cleared by Talk, a newer card or `SCREEN_SHOW_MS` after the answer ends. The `sensors` card is rebuilt from each new snapshot while it's up.
- **Fake cloud** scripts a `show_on_screen` tool call so `.walk` scripts can drive it without Gemini.

## The screen (packages/walker-screen)

One scene per card, measured at 800 by 480 at Largest with the longest allowed strings: the main value large (the temperature, the address, the nearest zone, the message, the part count), its details as lines, a dashed Simulated tag where the data is simulated, the caption line under the card, and a screen-reader announcement of the whole card when it appears. Preview fixtures for each card.

## Privacy

Unchanged from `get_weather` and `get_location`: coordinates go from the Pi to Open-Meteo and the geocoder only. The address and the weather already reach the model as tool results today. A caretaker's message words stay on the Pi and the screen. Logs carry the view name and timings only.

## Expected results (written before the code)

- Contract (done): a view list must be non-empty and unique; `show_on_screen` needs `view` and takes nothing else; each card takes only its own fields; a card can't hold coordinates or multi-line text.
- Cloud: the tool is offered only on a walker turn carrying `screen`, only with its views; a page turn gets the Talk line; a view not listed is refused; the step line is "Putting that on your screen."; the continuation's answer is the model's; existing tool tests still pass.
- Pi: `screen.views` matches what the walker has; each view's card is built from local data; the card shows over thinking and answering with the caption, and clears on Talk, a newer card and after `SCREEN_SHOW_MS`; an obstacle still takes the screen first; the message's words never appear in a turn request; failures show nothing. A `.walk` script: ask, see `showing weather`, hear the answer, card clears. Three runs in a row.
- Screen: every card fits at Largest with the longest strings, announces once, and shows Simulated where flagged.
- Live (the check a harness can't make): the Pi simulator against a local server with Gemini, "Show me the weather" and "Show me what the sensors see", three runs in a row.
