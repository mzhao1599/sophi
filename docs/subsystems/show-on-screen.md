# Show on screen guide: "Show me the weather"

**For:** whoever builds or demos the assistant's `show_on_screen` tool: the cloud assistant (`services/cloud-api/src/walker/`), the Pi service and its screen state machine (`devices/pi`), the walker screen (`packages/walker-screen`) and the shared contract (`packages/contracts`).

**Status (2026-10-24):** built on branch `show-on-screen`, not yet merged or deployed. The contract, the cloud (fake model), the Pi (unit tests and a `.walk` script, 3 of 3 in the simulator) and the screen (every card at 800x480 at every text size, in headless Chromium) are tested. Live with Gemini, the Pi simulator on a Mac against a local server passed "Show me the weather" and "Show me what the sensors see" three runs in a row, twice (see "Live results"), with simulated GPS and sample weather. Not run on the real Pi, with a real GPS fix, or on the walker's panel.

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

**Built and tested (2026-10-24), against a fake model,** then run live with Gemini against the Pi simulator and its screen page (see [Live results](#live-results-2026-10-24)). Not yet run against the real Pi. Code: `src/walker/assistant.ts`, `service.ts` and `hedge.ts`; the expected results are in `test/walker/EXPECTED-turns.md` ("Pulling something up on the walker's screen") and the tests in `test/walker/turn.test.ts`.

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
- **The screen machine** (`src/screen/machine.ts`) has the `showing` layer: obstacle, then motion, then listening, then the card, then thinking and answering. `caption` is the answer's current caption page for as long as the answering screen would show it (its pages and its 3 s hold), paged by `showingCaptionPages` (75 characters at every text size) and timed by those pages; null with captions off or no answer up. The card goes SCREEN_SHOW_MS after the answer has played (or after it was drawn, if none was playing), at a Talk press, or when a newer card replaces it; a later answer never brings it back. The sensors card follows each reading under the obstacle screen's SCREEN_ZONES_MIN_MS throttle, rounded to 10 mm, and a zone whose reading stops counting turns unknown on time.
- **Logs**: one line, `show_on_screen` with the view, whether it was shown, and the milliseconds.
- **Fake cloud and simulator**: a `.walk` script's `key show-<view>` makes the fake cloud's next turn ask for that view, only if the walker listed it; its continuation relays the walker's result word for word. `walker simulate --gps` adds a SIMULATED GPS receiver (its position is never shared) and SIMULATED weather and address samples that say so; no internet. `test/sim/show-weather.walk` passed three real-time runs in a row on 2026-10-24 in the simulator on a Mac, with a headless Chromium (chrome-headless-shell) on the page and the screen piece's real card layouts (and runs on a fake clock in the suite).
- **Not checked yet**: the real Pi and the panel. A live turn with Gemini has run only in the simulator on a Mac ([Live results](#live-results-2026-10-24)).

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
- Live (the check a harness can't make): the Pi simulator against a local server with Gemini, "Show me the weather" and "Show me what the sensors see", three runs in a row. Results below.

## Live results (2026-10-24)

**Passed three runs in a row twice:** first with a fix to the server's reply check (runs 5 to 7; without that fix, 2 of 4 runs failed), then again on `7afcfd1`, after the answer and simulated-weather changes (runs 8 to 10). The fix is committed as `bfa908c`. Nothing here ran on the real Pi, a real GPS receiver or the panel.

### First pass: runs 1 to 7

**Setup.** Everything ran on one Mac, 2026-10-24 between 21:29 and 21:51 PDT:
- the server: `next dev` from this branch (at `e839814`), with the in-memory store and Max's Gemini key. Spoken turns went to `gemini-3.7-flash`, with `gemini-3.6-flash` as the backup after 4.5 s (the server's defaults). There was no Cartesia key, so the walker spoke in its own voice;
- the walker: the Pi simulator (`walker simulate --server … --screen --gps --mic-file …`), bundled from the same commit and freshly paired for each run. `--gps` means a SIMULATED GPS fix and a SIMULATED weather sample (64°F, partly cloudy, wind 8 mph), with no internet involved. The obstacle sensors were the simulator's two simulated zones at 1500 mm;
- the screen page: open in headless Chromium (chrome-headless-shell, Playwright) at 800x480 for the whole run. A small script logged each scene change and screenshotted every card;
- the voice: synthetic clips from macOS `say` (16 kHz mono), "Show me the weather." and "Show me what the sensors see.", with Talk held for 2 s. Nothing played aloud.

A `.walk` script drove each run: boot, then a weather turn and a sensors turn. For each turn it waited for "Putting that on your screen.", the `showing` screen, the answer, no clock for 25 s, then the clock again.

**Timings** run from letting go of Talk to the step line arriving, and then to the answer arriving, both on the walker (from its log). "Cleared" is the time from the answer arriving to the clock returning.

| Run | Weather: step / answer | Sensors: step / answer | Cleared | Result |
| --- | --- | --- | --- | --- |
| 5 | 2.9 s / 5.4 s | 3.1 s / 9.7 s (see below) | 31.3 s, 31.6 s | pass |
| 6 | 2.3 s / 4.1 s | 2.8 s / 4.6 s | 31.3 s, 31.7 s | pass |
| 7 | 2.8 s / 5.2 s | 1.7 s / 3.6 s | 31.3 s, 31.7 s | pass |

In every turn of those runs:
- the walker logged `show_on_screen view="weather"` (or `"sensors"`) `shown=true`, and spoke the step line "Putting that on your screen.";
- the screen showed `showing:weather` (64°, "Partly cloudy skies", "Wind 8 mph", "Near you, from GPS" with a Simulated tag, "Weather data from Open-Meteo") or `showing:sensors` ("Front left · 150 cm" over both zones, each tagged Simulated), with the step line and then the answer as the caption;
- the card went back to the clock about 31.5 s after the answer arrived: 30 s (`SCREEN_SHOW_MS`) after the walker finished playing the answer.

Every final answer came from `gemini-3.7-flash` on its first attempt (server log). The answers were the same in all three runs:
- weather: "I am showing the weather on the screen.";
- sensors: "I am showing the obstacle sensors on the screen. These readings are simulated." The server adds the second sentence.

In run 5's sensors turn, the main model took more than 4.5 s on the continuation, so the backup's reply was used, and it asked for `show_on_screen` `sensors` a second time. The walker showed the card again, and the main model answered the next step, which made 9.7 s in all.

**What failed first, and why.** Runs 1 to 4 used the code as merged:
- run 1 passed (7.0 s and 7.1 s);
- run 2 failed on sensors with the fixed line "I can't answer that right now. Your alerts are set to buzzing and speech." (server: `reason=invalid_reply attempts=2`, 5.0 s);
- run 3 failed on weather with "I didn't catch that. Please speak again while holding the Talk button.", and no card;
- run 4 passed (6.3 s and 6.9 s).

From run 3 on, a preload in the server process logged each Gemini reply: only the model name, status, time, finish reason and reply text, never the key or the audio. It showed both models answering a `show_on_screen` step with `"reply": ""` next to a correct `tool_call`. The reply check (`WalkerReplySchema`, reply at least one character) rejected that. Each model then retried, which added about 2 s to every show turn. When both retries came back bad, the turn failed. In run 3 the backup's retry also lost the transcript and answered "I didn't catch that…", and that answer was used. Across runs 3 to 7, 15 of 18 logged first attempts at a turn's first show step had an empty reply. The model's reply is never spoken on that step, because the step line is the server's own. The prompt's rule "never say something is on the screen until a `show_on_screen` result says so" is a likely reason the model leaves it empty.

**The fix** (`services/cloud-api/src/walker/assistant.ts`, committed as `bfa908c`; runs 5 to 7 ran it uncommitted on top of `e839814`): an empty `reply` is accepted when the model asks for `show_on_screen` and something was heard (a non-empty transcript). Everywhere else a reply is still required, so an empty answer is still retried and can never be spoken. No prompt was changed. Two tests and two rows in `test/walker/EXPECTED-turns.md` cover it: the first test fails without the fix. The cloud suite passes (265) and typechecks.

**Seen in these runs** (the first, second and third points were addressed in `7afcfd1`; see the second pass):
- The answers don't say what's on the card. `gemini-3.7-flash` said "I am showing the weather on the screen." in every run, not "It's on your screen: 64 degrees and partly cloudy." So she hears "Putting that on your screen." and then much the same line again. `gemini-3.6-flash` did include the values ("…64 degrees and partly cloudy skies"), but its answers were never the ones used. On the sensors continuation it also said "1500 millimetres".
- The backup asked for the same card again after its result 2 times out of 9 continuation replies, both in one turn (run 5). The prompt already says to reuse a tool only when a fresh observation is needed. If this matters, one fix is for the server to treat a repeat of a view already in `tool_results` as the end of the tool loop.
- With `--gps`, the weather card still says "Weather data from Open-Meteo" over the simulated sample. The Simulated tag sits only on the "Near you, from GPS" line. On the real Pi the credit is true; in the simulator it isn't.
- A show turn is two model calls, so the answer took 3.6 to 5.4 s (9.7 s once) after letting go of Talk. That's slower than the 4 s design target. The step line comes sooner, at 1.7 to 3.1 s.

### Second pass: runs 8 to 10 (`7afcfd1`)

The same setup and the same two clips, 2026-10-24 between 22:00 and 22:05 PDT. The server and the Pi bundle were both rebuilt from `7afcfd1`. That head includes the reply-check fix (`bfa908c`). It also changes two things. The Screen prompt rule now tells the model not to repeat that the thing is on the screen, and to answer in one sentence with the main fact from the result, saying simulated when the result does. A simulated weather card now reads "Simulated weather, not a forecast" with a Simulated tag, and credits no provider. All three runs passed, back to back.

| Run | Weather: step / answer | Sensors: step / answer | Cleared | Result |
| --- | --- | --- | --- | --- |
| 8 | 2.8 s / 4.8 s | 2.2 s / 4.4 s | 31.5 s, 31.7 s | pass |
| 9 | 2.4 s / 4.1 s | 2.3 s / 4.4 s | 31.7 s, 31.7 s | pass |
| 10 | 2.2 s / 4.2 s | 1.9 s / 3.7 s | 31.6 s, 31.9 s | pass |

The checks were the same as in the first pass, and every turn met them: the `show_on_screen` log line with the right view and `shown=true`, the step line, the `showing:weather` or `showing:sensors` card, the answer as its caption, and the clock back 30 s after the answer played. The weather card read "64°", "Partly cloudy skies, wind 8 mph" and "Simulated weather, not a forecast", with a Simulated tag and no Open-Meteo credit.

Every final answer came from `gemini-3.7-flash` on its first attempt (server log). None says "on the screen", and each one states the main fact:

| Run | Weather answer | Sensors answer |
| --- | --- | --- |
| 8 | "It shows simulated weather of 64 degrees with partly cloudy skies." | "The nearest reading is 1500 millimetres. These readings are simulated." |
| 9 | "The simulated weather is 64 degrees Fahrenheit with partly cloudy skies." | "The nearest reading is 1500 millimetres. These readings are simulated." |
| 10 | "It shows simulated weather of 64 degrees Fahrenheit with partly cloudy skies." | "The nearest reading right now is 1500 millimetres in front. These readings are simulated." |

The server adds "These readings are simulated." The model's sensors answer didn't say simulated itself; the backup's usually did.

From the Gemini reply log:
- **Repeat requests:** no model asked for the same card again after its result (0 of 12 continuation replies, 6 per model).
- **Empty step replies:** 11 of 12 first attempts at the step had an empty reply. All were accepted, with no retries.
- **Speed:** with no retry and no repeat, every answer arrived 3.7 to 4.8 s after letting go of Talk, and the step line 1.9 to 2.8 s after.

**Seen in the second pass, not changed:**
- **Units:** the spoken sensors answer says "1500 millimetres" while the card says "150 cm". The walker's result gives the model millimetres (`devices/pi/src/show.ts`, the result words), but the card and the obstacle screen use centimetres.
  Fixed after this pass: the result now gives centimetres, as the card does ("front left 42 centimetres"); not re-run live.
- **Caption paging:** the 75-character caption pages break mid-sentence. Run 10's weather caption showed "It shows simulated weather of 64 degrees Fahrenheit with" and then "partly cloudy skies." on the next page.
- **Tag layout:** on the simulated weather card, the Simulated tag wraps onto a line of its own under "Simulated weather, not a forecast", which already says the same thing.

Logs, Gemini replies and screenshots are in the session's scratch folder, not the repo.
