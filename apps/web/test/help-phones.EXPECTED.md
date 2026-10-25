# Asking for help on the two phones: expected results

Written before the phones' help code (2026-10-24); updated the same day, before the code that depends on it, for the reviewed contract (`sent_to` and `shown_to` in place of `told`, people as `{ member_id, name }`, `closed.by`; nothing says "has been told"). Each line is something Rose's phone, Maya's phone, the client or the fake must do. The unit tests (`phone.test.ts`, `phone-screens.test.ts`, `care-live.test.ts`) and the headless two-phone runs check them. The design is [docs/subsystems/help.md](../../../docs/subsystems/help.md); the contract is `packages/contracts/src/circle.ts`, "Asking for help". Where this file and the contract disagree, the contract wins. Made-up names only (Rose, Maya, Ana).

Names below come from the request: `sent_to`, `shown_to` and `coming` are lists of phones (`{ member_id, name }`), joined the walker's way (`helpNames`: "Maya", "Maya and Ana", "Maya, Ana and Sam"). One phone: "Sent to Maya's phone.", "It's showing on Maya's phone.", "Maya is on the way."; more: "Sent to Maya and Ana's phones.", "It's showing on Maya and Ana's phones.", "Maya and Ana are on the way." Nothing says anyone "has been told": there are no push notifications, so the most a phone knows is that a caretaker's app received it (`shown_to`). "You" is decided by `member_id`, never by name (two caretakers can share a name).

## The client (`phoneApi.ts`)

- `askForHelp(clientHelpId)` sends `POST /api/v1/circle/help` with exactly `{ client_help_id }`, and answers the `help` of `{ help }` checked against `HelpResponseSchema`.
- `helpComing(helpId)` sends `POST /api/v1/circle/help/{help_id}/coming` and `helpOkay(helpId)` sends `POST /api/v1/circle/help/{help_id}/okay`, both with no body; the id is URL-encoded; both answer the `help`.
- `409 no_caretaker` becomes `PhoneApiError` `no_caretaker`. `409 help_closed` becomes `help_closed` and carries the request as it stands (`error.help`). `403 not_allowed`, a network failure, a plain 404 (`not_offered`) and a wrong shape (`unavailable`) behave as every other call.
- A home without `help`, or with a `help` the contract refuses (a `with_her` close with no `by`), is `unavailable`.

## The fake (`phoneFake.ts`)

Same rules as the server, every answer checked against the contract:
- Only her approved phone asks (a caretaker or a waiting phone: `not_allowed`). No approved caretaker: `no_caretaker`, and nothing is kept.
- `sent_to` is the approved caretaker phones when she asked, in joining order, and stays fixed (a caretaker approved later sees the request but isn't in `sent_to`; one removed later stays named). `source` is `phone` from her phone.
- `shown_to`: a caretaker's `home()` that carries the open request adds that phone, once, in the order they first got it. Her own phone's home, and a closed request, add nobody.
- Asking again while one is open returns that one; the same `client_help_id` returns its request even once closed; otherwise a new one.
- Only a caretaker says "on my way" (her phone: `not_allowed`); twice adds the phone once. Her `okay` closes it `okay` by her phone; a caretaker's closes it `with_her` by theirs (`closed.by` is `{ member_id, name }`). Anything on a closed one: `help_closed` with the request. An unknown id: `not_found`.
- The home's `help`: the open request, or the newest closed less than 5 minutes (`HELP_CLOSED_SHOWN_MS`) ago, or null. A waiting caretaker sees no help.
- By its own clock (`advance(ms)`): an open request closes itself `expired` (`by: null`) an hour after she asked (`HELP_OPEN_MAX_MS`); `age_seconds` grows with the clock; every request is gone 24 hours after she asked.
- Circle controls for tests and preview: the walker asks (`handles` or `voice`), a caretaker by name says on the way or with her, her walker's Confirm-twice okay (by her phone, or `by: null` with no phone of hers in), an hour passes, and a location fix for the walker.

## Rose's phone

### Home
- Four tiles; **Get help** is first. Its icon is its own shape (a raised hand in a ring) and its border is heavier than the others, so it isn't marked by colour alone. Its words: "Get help", and under it "Ask Maya" (all caretakers: "Ask Maya or Ana"; none: "No caretaker linked").
- With a request open, a banner leads the home, above the heading: "You asked for help." then the furthest step so far: "Sent to Maya's phone." (two: "Sent to Maya and Ana's phones."); once an app has it, "It's showing on Maya's phone." (the phones in `shown_to`); once someone answered, "Maya is on the way." The tile's second line says "Open: see who's coming".
- Within 5 minutes after it closed, the banner says how: `okay`: "You said you're okay. Maya's phone will show it." (two: "Maya and Ana's phones will show it."); `with_her`: "Maya says they're with you." (the walker's gender-neutral words); `expired`: "Your request for help has ended." Then it goes (the server stops sending it).
- The banner is text, not a control; it is never a live region (the change is announced once, below).

### Get help, nothing open
- Heading "Ask Maya for help?" ("Ask Maya and Ana for help?").
- One big **Ask for help** button (at least 88px tall, the full width).
- "It goes to Maya's phone. Sophi doesn't call 911." With two: "It goes to Maya and Ana's phones. Sophi doesn't call 911."
- Her location, from her own walker view: sharing on: "Location sharing is on, so Maya can see your walker's latest GPS position." (two: "… so Maya and Ana can see …"); off: "Location sharing is off, so Maya won't see where you are." (two: "Maya and Ana won't see …"). Nothing here turns it on.
- A **Call 911** link (`href="tel:911"`), styled as a secondary button, under everything else. It is never pressed in a test.
- No caretaker: heading "Get help", "No caretaker is linked to your walker.", no Ask button, and the Call 911 link.
- After a close (within 5 minutes): the closed line above, then the ask screen as usual, so she can ask again.

### Asking
- Tap **Ask for help**: the button says "Asking" and can't be pressed twice; `POST /circle/help` with one `client_help_id`; a retry after a failure reuses the same id.
- Success: the screen becomes the open status (below) from the server's answer, and the status line announces once "You asked for help. Sent to Maya's phone."
- `no_caretaker`: "No caretaker is linked to your walker, so nothing was sent." and the screen refreshes.
- Network or anything else: "Not sent: can't reach Sophi's server. Try again." (or "Not sent. Try again."), the button back, focus on the button.

### Open status
- Heading "You asked for help". "Sent to Maya's phone." Then, once an app has it, "It's showing on Maya's phone." Then "Nobody has said they're on the way yet." until someone answers, and "Maya is on the way." (two coming: "Maya and Ana are on the way.").
- How long ago: "Asked just now" under a minute, then "Asked 1 minute ago", "Asked 5 minutes ago".
- **I'm okay now** (a big button). Tapping it shows, in place, "Tell Maya you're okay?" with **Yes, I'm okay** and **Not yet**; focus moves to that question (her tap moved it). **Not yet** goes back, focus on **I'm okay now**. **Yes, I'm okay** sends `POST /circle/help/{id}/okay`, then shows "You said you're okay. Maya's phone will show it." With two sent to: "Tell Maya and Ana you're okay?"
- The Call 911 link stays on this screen.
- `help_closed` (a caretaker closed it first): the closed request from the error is shown ("Maya says they're with you.") and the screen refreshes; no error wording.

## Maya's phone

### An open request leads the app
- Above the section tabs, on every tab, a card headed "Rose asked for help" (an `h1`, the page's first heading, so a screen reader opening the app lands on it), with a ringed hand mark and a heavy ink border (shape and words, not colour alone).
- How: `handles` "from her walker", `voice` "by asking Sophi", `phone` "from her phone", and how long ago ("just now", "1 minute ago", "5 minutes ago"): "From her walker, just now."
- Who else it went to (by `member_id`): Maya in `sent_to` with Ana: "It also went to Ana's phone."; Maya alone: "It went only to your phone."; Maya not in `sent_to` (joined later): "It went to Ana's phone." / "It went to Maya and Ana's phones."
- Who is coming: nobody: "Nobody has said they're on the way yet."; "You're on the way."; "Ana is on the way."; "You and Ana are on the way." (her own phone becomes "You", by `member_id`, in `coming` order; another caretaker also named Maya stays "Maya").
- Location: `walker.location` present: the street map centred on it with one ringed pin labelled "Rose's walker", and "GPS fix from about 12 seconds ago. Map from OpenStreetMap." Sharing on but no fix: "No recent GPS fix from Rose's walker." Otherwise: "Rose's location isn't shared."
- **I'm on my way** (until her phone is in `coming`; then "You said you're on the way." in its place), **I'm with Rose**, and the **Call 911** link (`tel:911`).
- No walker user phone linked: the walker's name stands in for hers ("My walker asked for help").

### When it arrives (a new open request, not on load)
- A short two-note tone through Web Audio; if the browser blocks audio until a tap, nothing else changes and nothing throws.
- `navigator.vibrate` where it exists; never an error where it doesn't.
- The tab title becomes "Rose asked for help · Sophi" while open; back to the page's own title when closed.
- One polite live-region announcement: "Rose asked for help from her walker."
- Focus stays where it was. On first load with a request already open: the card (the page's first heading) and the title, but no tone, vibration or announcement.

### Answering
- **I'm on my way**: "Sending" on the button, `POST …/coming`; then "You said you're on the way." and one announcement "You're on the way."
- **I'm with Rose**: `POST …/okay`; the card becomes the closed line.
- `help_closed` (Rose said okay first, or Ana answered): the request from the error is shown closed ("Rose says she's okay."), no error wording, and the screen refreshes.
- Network failure: "Not sent: can't reach Sophi's server. Try again." under the buttons, and the button is back.

### Closed (shown while the server still sends it, 5 minutes)
- `okay`: "Rose says she's okay." (`by: null`, she said it on her walker with no phone of hers in: "Rose said she's okay on her walker.") `with_her` by another caretaker: "Ana is with Rose."; by Maya: "You're with Rose."; `expired`: "Rose's request for help has ended." One announcement of that line when it changes; no tone.
- No buttons in the card, no Call 911 link in it.

## Both phones

- Every change is announced once through the app's one polite live region: a new request, on her phone a phone newly in `shown_to` ("It's showing on Maya's phone."), a new phone in `coming`, a close. Maya's phone doesn't announce `shown_to` (its own app is usually the one added). Never on load, never twice (Strict Mode runs effects twice in development: compare with the last value, not a first-run flag).
- Focus never moves by itself; only her own taps move it (the okay question).
- Every control is a real `<button>` or link with a visible name; focus is a 3px ring; everything works by Tab, Enter and Space.
- 200% text: no horizontal scroll at 390px wide, nothing cut off. Dark mode: the same shapes, readable contrast. Reduced motion: no fade.
- Calm words: "asked for help", never "SOS", "emergency" or "alarm"; the only 911 is the "Call 911" link.

## Polling and live updates

- Without a live `my_help` subscription, a phone polls every 2 s (`PHONE_POLL_MS`), so a request reaches Maya's open app within about 2 s. Only with live updates that include `my_help` does it slow to 10 s.
- With `my_help` subscribed (once the server's bindings exist): any insert, update or delete in it fetches `GET /api/v1/circle` at once; the first rows after connecting don't.
- `refresh()` after an action always ends with a fetch that started after the action, even if a poll was already in flight.

## Preview (`/app?preview=rose`, `?preview=maya`; development only)

- A dashed "Preview controls" panel under the app: **The walker asks** (handles), **Asks by voice**, **Maya: on my way**, **Ana: on my way** (with two caretakers), **Maya: with Rose**, **Rose: okay (walker)**, **An hour passes**. Each refreshes the phone at once.
- `&caretakers=0|1|2` (default 1) gives no caretaker, Maya, or Maya and Ana; `&location=1` turns her sharing on with a made-up fix at the sample's starting point.
- The page still says "Preview" on every screen.

## Headless runs (Chromium, 390 x 844)

- Two contexts, Rose and Maya, one shared circle: Rose taps Get help, Ask for help → Maya's phone shows "Rose asked for help" → Maya taps I'm on my way → Rose's banner says "Maya is on the way." → Rose taps I'm okay now, Yes, I'm okay → Maya's card says "Rose says she's okay." Three runs in a row, the time from Rose's tap to Maya's card recorded.
- The race: Maya taps I'm with Rose while Rose's Yes has already closed it: Maya's card shows "Rose says she's okay.", no error.
- 200% text, dark mode with reduced motion, keyboard only, and the alert's accessibility tree (a region named "Rose asked for help" with its buttons and link).
- Not a real iPhone: the tone, vibration, Home Screen app, VoiceOver and Dynamic Type stay unverified until tried on one.
