# Show on screen guide: "Show me the weather"

**For:** whoever builds or demos the assistant's `show_on_screen` tool: the cloud assistant (`services/cloud-api/src/walker/`), the Pi service and its screen state machine (`devices/pi`), the walker screen (`packages/walker-screen`) and the shared contract (`packages/contracts`).

**Status (2026-10-24, design):** the contract below is written and tested. Nothing else is built until this line says so.

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

- The model's JSON schema gains `{name: "show_on_screen", view}` with `view` restricted to the turn's `screen.views`; offered only on a spoken walker turn that carries `screen`. The context gains `screen_views` (the list, or none).
- System prompt: when she asks to see, show or pull up one of those things on the screen, request `show_on_screen` with that view; never say it is on the screen until the tool result says so; a view not in `screen_views` can't be shown, so say so. A page turn asking for it gets "Please use Talk on the walker for that request."
- The "I'll check" line for the step is "Putting that on your screen." The loop continues like the other device tools, under the same `client_turn_id` and tool budget.

## The Pi (devices/pi)

**Built and tested 2026-10-24, with fakes and in the simulator only.** Nothing here has run on the real Pi, a real GPS fix or the panel, and the screen still draws a placeholder for the card (its real layouts are the screen piece). Expected results: `devices/pi/test/EXPECTED.md`, rows SH1 to SH13; tests: `devices/pi/test/show.test.ts`.

- **Turn requests** carry `screen.views` on the first step and every continuation, only while a page's stream is open on the screen server (`service.setScreen`, wired in `src/screen/index.ts`). Views: `weather` and `location` with the GPS connected, `sensors` with an obstacle-sensor module, `message` when the walker holds a caretaker message, `parts` always. No page, no field.
- **Running the tool** (`src/show.ts`, `WalkerService.runShow`): `weather` and `location` take one GPS fix and the same providers as `get_weather` and `get_location`, which now return structured values as well as the unchanged sentence (`currentWeather`, `lookUpPlace`). Results: "Showing the weather on the screen: " or "Showing the nearest address on the screen: " and that sentence; the card's address is the venue and area, shortened (never invented) to fit 120 characters. `sensors`: every zone heard of, measured only when valid and fresh, otherwise unknown, never clear. `message`: the newest message held; the result names the sender only. `parts`: the capability manifest's first 16 parts. Each card is checked against `ShowCardSchema` before it is shown. A view it can't fill (no GPS, no fix, a provider error, no reliable address, no zone yet, no message, the page gone) shows nothing and the result starts "Nothing was shown on the screen." with the reason. `simulated` comes from the GPS receiver's own flag (weather, location) or each part's (sensors, parts).
- **The screen machine** (`src/screen/machine.ts`) has the `showing` layer: obstacle, then motion, then listening, then the card, then thinking and answering. `caption` is the answer's current caption page for as long as the answering screen would show it (its pages and its 3 s hold); null with captions off or no answer up. The card goes SCREEN_SHOW_MS after the answer has played (or after it was drawn, if none was playing), at a Talk press, or when a newer card replaces it; a later answer never brings it back. The sensors card follows each reading under the obstacle screen's SCREEN_ZONES_MIN_MS throttle, rounded to 10 mm, and a zone whose reading stops counting turns unknown on time.
- **Logs**: one line, `show_on_screen` with the view, whether it was shown, and the milliseconds.
- **Fake cloud and simulator**: a `.walk` script's `key show-<view>` makes the fake cloud's next turn ask for that view, only if the walker listed it; its continuation relays the walker's result word for word. `walker simulate --gps` adds a SIMULATED GPS receiver (its position is never shared) and SIMULATED weather and address samples that say so; no internet. `test/sim/show-weather.walk` passed three real-time runs in a row in the simulator with a headless Chromium on the page (and runs on a fake clock in the suite).
- **Not checked yet**: a live turn against the real server with Gemini (the cloud piece), the real card layouts, the Pi and the panel.

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
