# Asking for help (the walker's "Get help")

**For:** whoever builds or demos asking for help: the contract (`packages/contracts`), the server and the care database (`services/cloud-api`, `services/care-db`, `apps/web/app/api`), the Pi and its screen (`devices/pi`, `packages/walker-screen`), and the two phones (`apps/web`, `/app`).

**Status (2026-10-24):** the contract is written, with tests: the shared request view, timings and the walker's routes in [`walker.ts`](../../packages/contracts/src/walker.ts) ("Asking for help", plus `can_ask_for_help` and `ask_for_help` on a turn), and the phone routes and the walker screen's states in [`circle.ts`](../../packages/contracts/src/circle.ts). Nothing else is built yet. Update this line as each piece lands.

## What it is

Rose (made up, as in the [demo](../demo/tracks.md)) can ask her caretakers for help three ways. The request is sent to every approved caretaker phone in her circle and shows on each one whose app is open:

| Where she asks | How | What makes it deliberate |
| --- | --- | --- |
| The walker's handles | Hold **Talk** (right) and **Confirm** (left) together for 2 s (`HELP_HOLD_MS`) | Both hands, held. Letting go early sends nothing |
| Her voice | Hold Talk: "I've fallen. Please get Maya." The model may answer with `ask_for_help` | The walker counts down 8 s (`HELP_COUNTDOWN_MS`) and any handle press stops it. The model never creates a request; the Pi does, after the countdown |
| Her phone | The **Get help** tile, then one big **Ask for help** button | Two taps on purpose |

A caretaker's phone shows "Rose asked for help" with how and how long ago, her location only if she already turned sharing on, and two answers: **I'm on my way** (her walker then says "Maya is on the way.") and **I'm with Rose** (closes it). It closes when she says she's okay (her phone, or Confirm twice on the walker), when a caretaker says they're with her, or by itself after an hour (`HELP_OPEN_MAX_MS`).

**What it is not, said the same way everywhere:**
- Sophi never calls 911 or any emergency number, and sends no SMS. It sends to the caretaker phones in her circle. Both phones show a plain "Call 911" link (`tel:911`) so the person holding the phone can call; the phone's own dialer asks before calling. Never tap it in a demo.
- There are no push notifications yet: a caretaker's phone shows the request only while the app is open (live, or within its next poll). That is why nothing says "Maya has been told": the walker says "Sent to Maya's phone.", and "It's showing on Maya's phone." only once her app has received it (`shown_to`), which still means the app had it, not that she read it.
- There is no fall detection: the walker has no motion sensor. Only her own request starts one.
- It needs the internet. Offline, the walker keeps trying for 2 minutes (`HELP_SEND_RETRY_MS`), then says nothing was sent.

## The calm-wording rule

The walker's screen never words anything as an emergency (the [screen's rule](../../packages/walker-screen/README.md), tested). Help keeps it: "Asking for help", "Sent to Maya's phone", "Maya is on the way". The phones may say "asked for help"; nothing says "SOS", "emergency" or "alarm" except the "Call 911" link.

## The shared noun: one help request

Defined once in `walker.ts` (`HelpViewSchema`; it lives there so the walker's error envelope can carry it), the same shape for the walker and every phone. People are named by phone (`{ member_id, name }`), because the owner types names and two caretakers can share one:

- `help_id`, `source` (`handles`, `voice`, `phone`), `age_seconds` (the server's clock; no exact times, like the location fix);
- `sent_to`: the approved caretaker phones when she asked, fixed then, in joining order (at least one: with none, the server refuses `409 no_caretaker` and keeps nothing);
- `shown_to`: caretaker phones whose app received it while it was open (a `GET /api/v1/circle` answer carried it), first first;
- `coming`: caretakers who answered "I'm on my way", first first;
- `closed`: null while open, else `how` (`okay`, `with_her`, `expired`) and `by` (the caretaker for `with_her`; her phone for `okay`, or null when she said it on the walker with no phone of hers in; null for `expired`).

**One open request per walker.** Asking again while one is open returns it (`200`) and records the new `client_help_id` as another name for it, so a retry after a lost answer never opens a second request; a repeated `client_help_id` returns its request even once closed; a new one is `201`. Answering a closed one is `409 help_closed` with the request as it stands. The first close wins.

### Routes

| Route | Caller | What it does |
| --- | --- | --- |
| `POST /api/v1/devices/{id}/help` `{ client_help_id, source: handles \| voice }` | the walker | Ask. → `{ help }` |
| `GET /api/v1/devices/{id}/help` | the walker | The open request, or the newest closed within 5 min (`HELP_CLOSED_SHOWN_MS`), or null. Polled after each heartbeat and every 2 s (`HELP_POLL_MS`) while one is open |
| `POST /api/v1/devices/{id}/help/{help_id}/okay` | the walker | Her second Confirm press: closes it `okay` |
| `POST /api/v1/circle/help` `{ client_help_id }` | her phone only | Ask (`source: phone`). A caretaker gets `403 not_allowed` |
| `POST /api/v1/circle/help/{help_id}/coming` | a caretaker's phone only | "I'm on my way". Repeating it changes nothing |
| `POST /api/v1/circle/help/{help_id}/okay` | either phone | Her phone: "I'm okay now" (`okay`). A caretaker's: "I'm with Rose" (`with_her`) |
| `GET /api/v1/circle` | either phone | `help` on the member answer: the same as the walker's GET. A caretaker's answer that carries an open request adds that phone to `shown_to` |

The walker's routes answer errors in the walker envelope (`WalkerErrorSchema`, which now has `no_caretaker`, `help_closed` and `help`); the phones' in the circle envelope. A phone sees the walker's request if it is a member now (a caretaker who joined after she asked sees it, but isn't in `sent_to`). A waiting caretaker sees nothing.

### Where it is kept

In the same circle store as messages: the in-memory and Postgres walker store (a new migration) and, when the server has the `SPACETIME_*` settings, SpacetimeDB (`services/care-db`: a private `help_request` table, procedures in the CircleStore pattern, and a `my_help` view). The `my_help` view gives a member one row per help request of its walker: `{ help_id: string, rev: u64 }`, where `rev` goes up on every change. A phone that sees any change to `my_help` fetches `GET /api/v1/circle` at once and draws the server's `help`; the view carries no names, location or times. The owner's page doesn't see help requests in this version.

## Consent, privacy and retention

- **Who sees it:** her phone, the approved caretaker phones in her circle now, and her walker. Not the owner's page, not a waiting caretaker, not the model, except one line in her own later Talk turns while one is open (sent to, showing on, coming), so "Is Maya coming?" is answered from the server's state. No location ever goes to the model.
- **Location:** a caretaker sees her position only through the existing opt-in (`PhoneWalkerView.location`: her phone's switch, a fresh fix, a real walker, not the simulator). Asking for help never turns sharing on and stores no location of its own. Her phone's Get help screen says whether her location is shared.
- **Retention:** deleted 24 hours after she asked (`HELP_RETENTION_MS`), open or not, by the circle's sweep; at once with "Forget this walker". Removing a phone doesn't delete the walker's requests (her request is hers), but that phone sees nothing more.
- **Logs:** ids, sources, outcomes and timings; never names or locations.
- The caretaker consent line (`caregiverConsentLine`) now also says the caretaker is told when she asks for help; the owner ticks it as before.

## The walker (Pi)

The Pi decides everything on the walker; the server never pushes to it.

### The chord, and who owns Confirm

- **Raw edges first.** The chord detector reads every handle edge before the motion coordinator's claim (`motion.handlePress` claims presses today), so a chord is seen even while something moves. A press still stops a running motion at once, exactly as now: stopping never waits.
- **Confirm waits for a chord.** A Confirm press that would start something (a motion target, an open model offer, a message draft, arming "I'm okay") waits `HELP_CHORD_WINDOW_MS` (250 ms) and is dropped if Talk goes down within it. A Talk press within the same window after a Confirm makes the pair a chord. A Talk press that starts a recording drops that recording if Confirm goes down while it is held (no turn is sent).
- **The hold.** Both down: the `help` cue and `help_hold`. Still both down at `HELP_HOLD_MS`: ask (`source: handles`). Either let go before then: back to what was on screen, nothing sent.
- **Confirm during help.** While `help_hold`, `help_countdown` or an open request shows, help owns Confirm. A pending motion target isn't answered by it (the coordinator is asked to withdraw it and refuse new ones while help is active; a pending "Let go?" stays pending and the arm keeps holding, which is its safe state). An open model offer or message draft that arrives meanwhile is declined, as the Pi already does while something else owns Confirm. A Confirm press that is part of a chord never arms or closes help: only a lone Confirm (no Talk within the window) arms "I'm okay", and only a second lone Confirm within `HELP_OKAY_ARMED_TTL_MS` closes it.

### Voice, sending and polling

- **Voice.** The walker adds `can_ask_for_help: true` to every request of a Talk turn (continuations included), but only after a `GET /devices/{id}/help` has answered `200` in this run, because an older server refuses unknown fields on that strict request. On a turn answer with `ask_for_help: true`, the Pi says the reply (a fixed server line, below), then shows `help_countdown` from 8 and counts down once a second. Any handle press during the countdown stops it, and that press does nothing else. At zero it asks (`source: voice`).
- **Sending.** One `client_help_id` per ask, kept until it succeeds or gives up. Network errors and `5xx` retry every 5 s up to `HELP_SEND_RETRY_MS` (`sending`, `retrying: true` after the first failure, said once). `409 no_caretaker` → `not_sent` `no_caretaker`. Any other `4xx` → `not_sent` `failed`. Out of time → `not_sent` `offline`.
- **Open.** The `help` screen stays under her Talk turns (a Talk turn shows, then the screen comes back to help). The Pi polls `GET /devices/{id}/help` every `HELP_POLL_MS` and says each new phone in `shown_to` and in `coming` once. A request made on her phone shows on the walker too, from the poll after a heartbeat. `/okay` answered `409 help_closed` with `closed.how === "okay"` counts as success (a retry whose first try got through).
- **Closed.** The walker announces a close only for a `help_id` it saw open in this run (after a restart, a request closed in the last 5 minutes isn't announced again). It shows `help` `closed` for 10 s, says its line once, then the screen goes back to normal.
- **An older server** (`404` on `/help`): the Pi doesn't poll again for 60 s, like the circle feed, never sends `can_ask_for_help`, and a chord gets `not_sent` `failed`.

### The walker's fixed lines

Pi code, never a model's. `{names}` is `helpNames(...)` of the phones' names. Every line is gender-neutral: the walker can't know anyone's pronouns.

| When | Spoken | Screen |
| --- | --- | --- |
| Both buttons down | the `help` cue | `help_hold`: "Keep holding to ask for help." |
| Hold complete, or countdown at zero | "Asking for help." | `help` `sending` |
| Countdown | the server's reply (below) | `help_countdown`: "Asking for help in 8 seconds." "Press any button to stop." |
| Countdown stopped | "Okay. I didn't ask anyone." | back to normal |
| First failure | "No internet yet. I'll keep trying." | `sending`, retrying |
| Server took it | "Sent to {names}'s phone." / "Sent to {names}'s phones." (one / more) | `open` |
| A phone shows it | "It's showing on {names}'s phone." (each phone once) | `open`, with `shown_to` |
| A caretaker is coming | "{names} is on the way." / "{names} are on the way." | `open`, with `coming` |
| First lone Confirm while open | "Press Confirm again to tell {names} you're okay." | `open`, `confirm_okay` |
| Closed by her | "Okay. {names} will see that you're okay." | `closed` `okay` |
| Closed by a caretaker | "{name} says they're with you." | `closed` `with_her` |
| Expired | "Your request for help has ended." | `closed` `expired` |
| No caretaker | "No caretaker's phone is linked to this walker, so nothing was sent." | `not_sent` |
| Gave up offline | "I couldn't reach the internet, so nothing was sent. Use your phone if you can." | `not_sent` |
| Other failure | "Something went wrong, so nothing was sent. Use your phone if you can." | `not_sent` |

**The simulator:** `h` in the terminal runs a whole chord (both down, 2 s, both up), and the `.walk` script gets a matching verb. The fake cloud implements the device routes and can answer as a caretaker would (shown, coming, with her).

## The server's voice path

- The server offers the model an `ask_for_help` tool only on a walker turn that carries `can_ask_for_help` and only when the walker has at least one approved caretaker; never on a typed page turn. A model that sets it anyway on any other turn is ignored.
- The prompt rule: use it only when the person asks for a person's help, or says they fell, are hurt, stuck or can't get up; never for "what can you help me with?"; never claim to have called, told or reached anyone, or closed a request.
- When the model chooses it, the server replaces the reply with a fixed line, "I'll ask {names} for help in 8 seconds. Press any button to stop.", and returns `ask_for_help: true` with no proposal, message draft or tool call (the contract refuses the mix). No request exists yet.
- With no approved caretaker, a help request by voice gets the fixed reply "No caretaker's phone is linked to this walker, so I can't ask anyone. If you need help now, call 911 from your phone."
- The model's per-turn context gets one line while a request is open (sent to, showing on, coming), so "Is Maya coming?" is answered from the server's state.

## The phones

**Rose's phone (simple mode).** A fourth tile, **Get help**, first in the list, marked with a shape and a word, not colour alone. Its screen: "Ask Maya for help?" (all caretakers' names), one big **Ask for help** button, then "It goes to Maya's phone. Sophi doesn't call 911.", whether her location is shared, and a "Call 911" link. With no caretaker: "No caretaker is linked to your walker." and no button. While a request is open, a banner leads her home screen ("You asked for help. Sent to Maya's phone." / "It's showing on Maya's phone." / "Maya is on the way.") and the tile opens the status, with **I'm okay now**, which asks "Tell Maya you're okay?" (**Yes, I'm okay** / **Not yet**). After it closes, the banner says how for 5 minutes.

**Maya's phone.** An open request leads the app: "Rose asked for help", how ("from her walker", "by asking Sophi", "from her phone") and how long ago, who else it went to and who is coming (her own answer as "You're on the way"), her location on the street map only if shared (else "Rose's location isn't shared."), **I'm on my way**, **I'm with Rose**, and the "Call 911" link. When one arrives while the app is open: a short tone (Web Audio; it may be blocked until the page has had a tap), `navigator.vibrate` where the browser has it, and the tab title. When she opens the app and one is already open, it is the page's first heading and in the tab title, so a screen reader lands on it. After it closes: "Rose says she's okay." (or "Rose said she's okay on her walker." when she had no phone in) or "Maya is with Rose." for 5 minutes.

**Both:** an arrival is announced through a live region once, and focus never jumps on its own; every control is a real button with a name; 200% text, reduced motion and dark mode as the rest of the app. The preview fake (`?preview=rose`, `?preview=maya`) gets help controls.

## Accessibility

Three ways to ask, none of them voice-only or fine-motor-only: two big buttons held (gross motor, both hands), her voice, or two taps on a big phone button. On the walker, stopping a countdown and saying "I'm okay" are handle presses only; her phone is the touch path for both (it can close a request, and a countdown stopped by nothing sends after 8 s, which she can then close from the phone). Every spoken line is on the walker's screen too. The phones work by keyboard and screen reader with large text, and the alert is a word and a shape, not only a colour or a sound.

## The demo beat (once built and rehearsed 3 of 3)

1. Presenter holds Talk: "I've fallen. Please get Maya." The walker: "I'll ask Maya for help in 8 seconds. Press any button to stop." The screen counts down.
2. At zero: "Asking for help." then "Sent to Maya's phone." Maya's phone, held up, shows "Rose asked for help", and the walker says "It's showing on Maya's phone." (measure the time from the walker's ask to her screen).
3. Maya taps **I'm on my way**. The walker: "Maya is on the way." Rose's phone banner says so.
4. Rose presses Confirm twice: "Okay. Maya will see that you're okay." Maya's phone: "Rose says she's okay."

**Fallback:** if the voice turn fails or is slow, hold both handle buttons for 2 s (on the simulator, press `h`). Don't say it detects falls, calls 911 or reaches a phone whose app is closed.

**Deploy order:** the server first (with the care database published), then the walker's bundle. A new walker talks to an old server safely (it sends `can_ask_for_help` only after `/help` answers), but the demo needs both.

## Build split

Built on the contract above, in three pieces, each in its own worktree from branch `sos`, each writing its expected results before code:

1. **Server and care database:** the store (memory, Postgres migration, SpacetimeDB module with `help_request`, procedures, sweep, forget, `my_help`), the circle service's help methods, `help` and `shown_to` on the phone home, the device routes (walker envelope) and member routes (circle envelope) in `apps/web`, the voice tool and its fixed lines, generated bindings. Publishing the module to Maincloud needs Max's OK.
2. **The walker:** the chord and Confirm ownership, countdown, sending, polling, lines and cues in `devices/pi`, the help screens in `packages/walker-screen`, the simulator key and script verb, the fake cloud's routes, the rebundled `dist/walker.mjs`.
3. **The phones:** Rose's tile and screens, Maya's alert, `phoneApi`, `phoneFake`, `usePhone`, the `my_help` live refetch (once the bindings exist), and the preview controls.
