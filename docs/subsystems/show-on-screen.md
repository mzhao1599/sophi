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

**Built and tested 2026-10-24, with fakes and in the simulator only.** Nothing here has run on the real Pi, a real GPS fix or the panel, and the screen still draws a placeholder for the card (its real layouts are the screen piece). Expected results: `devices/pi/test/EXPECTED.md`, rows SH1 to SH13; tests: `devices/pi/test/show.test.ts`.

- **Turn requests** carry `screen.views` on the first step and every continuation, only while a page's stream is open on the screen server (`service.setScreen`, wired in `src/screen/index.ts`). Views: `weather` and `location` with the GPS connected, `sensors` with an obstacle-sensor module, `message` when the walker holds a caretaker message, `parts` always. No page, no field.
- **Running the tool** (`src/show.ts`, `WalkerService.runShow`): `weather` and `location` take one GPS fix and the same providers as `get_weather` and `get_location`, which now return structured values as well as the unchanged sentence (`currentWeather`, `lookUpPlace`). Results: "Showing the weather on the screen: " or "Showing the nearest address on the screen: " and that sentence; the card's address is the venue and area, shortened (never invented) to fit 120 characters. `sensors`: every zone heard of, measured only when valid and fresh, otherwise unknown, never clear. `message`: the newest message held; the result names the sender only. `parts`: the capability manifest's first 16 parts. Each card is checked against `ShowCardSchema` before it is shown. A view it can't fill (no GPS, no fix, a provider error, no reliable address, no zone yet, no message, the page gone) shows nothing and the result starts "Nothing was shown on the screen." with the reason. `simulated` comes from the GPS receiver's own flag (weather, location) or each part's (sensors, parts).
- **The screen machine** (`src/screen/machine.ts`) has the `showing` layer: obstacle, then motion, then listening, then the card, then thinking and answering. `caption` is the answer's current caption page for as long as the answering screen would show it (its pages and its 3 s hold); null with captions off or no answer up. The card goes SCREEN_SHOW_MS after the answer has played (or after it was drawn, if none was playing), at a Talk press, or when a newer card replaces it; a later answer never brings it back. The sensors card follows each reading under the obstacle screen's SCREEN_ZONES_MIN_MS throttle, rounded to 10 mm, and a zone whose reading stops counting turns unknown on time.
- **Logs**: one line, `show_on_screen` with the view, whether it was shown, and the milliseconds.
- **Fake cloud and simulator**: a `.walk` script's `key show-<view>` makes the fake cloud's next turn ask for that view, only if the walker listed it; its continuation relays the walker's result word for word. `walker simulate --gps` adds a SIMULATED GPS receiver (its position is never shared) and SIMULATED weather and address samples that say so; no internet. `test/sim/show-weather.walk` passed three real-time runs in a row in the simulator with a headless Chromium on the page (and runs on a fake clock in the suite).
- **Not checked yet**: a live turn against the real server with Gemini (the cloud piece), the real card layouts, the Pi and the panel.

## The screen (packages/walker-screen)

**Built (2026-10-24).** One scene per card in `screenView` (`src/view.ts`, `showingScene`). The main value is large, its details are lines under it, and each card fits 800 by 480 at every text size with the longest strings the contract allows:

| Card | Main line | Lines | Between the handles | Heard by a screen reader |
| --- | --- | --- | --- | --- |
| `weather` | "64°" | "Partly cloudy skies", "Wind 8 mph" (joined as "Partly cloudy skies, wind 8 mph" when room is short); "Near you, from GPS" with a Simulated tag when the position is simulated | "Weather data from Open-Meteo", always | "64 degrees Fahrenheit, partly cloudy skies, wind 8 miles per hour. Weather data from Open-Meteo." |
| `location` | the address | "Near you, from GPS", Simulated when it is | "© OpenStreetMap contributors" (the address comes from Nominatim) | "Near you, from GPS: 600 Bellevue Avenue, Oakland." |
| `sensors` | the nearest measured zone, "Front left · 30 cm" (centimetres, as the obstacle screen), or "Not measured" | each zone in the Pi's order, "Front right · Not measured" when unknown, each with its own Simulated tag | nothing | "Sensor readings on screen, updated as they come: front left and front right. Simulated." |
| `message` | the words, at the message screen's size | "From Maya"; no Confirm hint (the Pi doesn't replay from this card) | nothing | "Maya says: …" |
| `parts` | "4 parts" | each part's catalog name and health in words (Working, Needs a check, Not working, Not responding), problems first, then simulated parts; a simulated part shows its name and a Simulated tag, never "Working" | nothing | every part and its health, simulated ones said |

- **Never "clear" or "safe".** An unknown zone reads "Not measured" on the line, in the main line when none is measured, and in the "and N more" count.
- **Fitting.** Sizes come from the measuring helpers in `view.ts` (the height budget per card is written above `showingScene`). The main line takes the largest of the main, message, bold body and bold smallest sizes that leaves room; lines drop to the smallest size before that. Lists (zones, parts) show as many items as fit, then "and N more" with how many of those aren't measured and, unless every item is simulated, how many are simulated. With captions on, the demo's two zones show in full at every text size, but four parts show two and "and 2 more, 1 simulated" (all four with captions off); 16 zones or parts at their longest leave room for one. The sensors card is sized as if every zone read "Not measured" and the nearest were the farthest possible, so a new reading never changes its sizes.
- **Announced once.** The scene key and the announcement name what the card says, never the caption or the sensors' readings, so a screen reader hears a card when it appears and again only when it is a different card (another zone list, another message, a part's health changing). The readings stay on screen and in Sophi's spoken answer.
- **Caption.** With captions on, Sophi's current caption page is the last line, at the smallest size under a hairline, so it doesn't read as one of the card's lines. Room for a whole page is kept from the moment the card appears, so the card doesn't move as pages turn or when the answer ends. A page under a card is at most two lines of the smallest size: `SHOWING_CAPTION_CHARS` (75 characters) at every text size. **The Pi pages the reply with `showingCaptionPages(text)` while a card is up**, not `captionPages(text, textSize)` (110 characters at Large is three lines, which left no room for a long address); a longer caption is shortened at a word on screen, never clipped. Captions off: no caption line, and no room kept.
- **Fixtures.** `showing-*` in `src/fixtures.ts`, illustrative data: each card, a simulated one, captions off, and the longest strings (`-150°` with 40-character conditions and 300 mph wind, a 120-character address, 16 zones with 24-character names, the longest message from the longest name, 16 parts), each at every text size. The web app's `/dev/preview/[screen]` doesn't draw walker-screen fixtures, so nothing changes there.
- **Proof.** `test/showing.test.ts` (expected results first) checks every card's words, the Simulated tags, never clear or safe, the caption line, that the key and announcement hold through new readings, and every card fixture's estimated height. The screenshot check drew all 207 fixtures, the 42 card ones among them, at 800x480 in headless Chromium with nothing overflowing and every text 7:1 or better (2026-10-24).

## Privacy

Unchanged from `get_weather` and `get_location`: coordinates go from the Pi to Open-Meteo and the geocoder only. The address and the weather already reach the model as tool results today. A caretaker's message words stay on the Pi and the screen. Logs carry the view name and timings only.

## Expected results (written before the code)

- Contract (done): a view list must be non-empty and unique; `show_on_screen` needs `view` and takes nothing else; each card takes only its own fields; a card can't hold coordinates or multi-line text.
- Cloud: the tool is offered only on a walker turn carrying `screen`, only with its views; a page turn gets the Talk line; a view not listed is refused; the step line is "Putting that on your screen."; the continuation's answer is the model's; existing tool tests still pass.
- Pi: `screen.views` matches what the walker has; each view's card is built from local data; the card shows over thinking and answering with the caption, and clears on Talk, a newer card and after `SCREEN_SHOW_MS`; an obstacle still takes the screen first; the message's words never appear in a turn request; failures show nothing. A `.walk` script: ask, see `showing weather`, hear the answer, card clears. Three runs in a row.
- Screen: every card fits at Largest with the longest strings, announces once, and shows Simulated where flagged.
- Live (the check a harness can't make): the Pi simulator against a local server with Gemini, "Show me the weather" and "Show me what the sensors see", three runs in a row.
