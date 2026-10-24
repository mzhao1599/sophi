# "Your walker" page (`/walker`): expected results

Written before the page was built (2026-10-24). Each line is something the page must do; the unit tests (`walker-page.test.ts`) and the browser-pane run against the fake check them. The contract is `packages/contracts/src/walker.ts`; where this file and the contract disagree, the contract wins.

Times below are on the server's clock. The page estimates it from each response's `Date` header (the fake's offset is 0), so a laptop with a wrong clock still counts down correctly to within about a second.

## States

### Loading
- Before the first answer from `GET /api/v1/walkers`: "Loading your walker", no buttons that act on a walker.

### No walker (`GET` answers `401`, or `200` with no walkers)
- Heading "Connect a walker", one line saying what pairing does, and a **Get a pairing code** button.
- The drawing shows only the bare frame.
- Pressing it sends `POST /api/v1/walkers/pairing-codes`. While it waits, the button says "Getting a code" and can't be pressed twice.
- Then, with focus moved to it (a group named "Pairing code 4 8 2 9 1 3", so a screen reader reads it once, digit by digit; it isn't also put in the live region): the 6-digit code, large and split 3 + 3 for reading aloud ("482 913"); a countdown "Expires in 10:00" that ticks each second and is never announced each second; and "On the walker, run:" with `walker pair 482913 --server <this site's origin>` and a **Copy** button.
- At `expires_at` the code is replaced by "That code expired." and **Get a new code**.
- When the next poll lists a walker, the page switches to the paired view, announces "Paired with <name>." once, and moves focus to the walker's name if focus was lost with the code panel. Focus moves to the new view's heading the same way whenever the view changes under it (paired, back to Connect a walker on a 401, the last walker gone).

### Paired
- **Walker name** as the page heading.
- **Online or offline, in words:** "Online" with a green dot, or "Offline" with a hollow dot and "last seen 3 min ago" (from `last_seen_at`; "never seen" when null). The word is always shown; colour is never the only signal.
- **Simulator badge:** "Simulator" next to the name exactly when `simulator` is true, with the line "This walker is the simulator running on a computer, not a Pi."
- **Parts** (from `parts`, in catalog order, one row per part, so two hand controls are two rows): each with its catalog name and its health in words: Healthy (`ok`), Degraded, Fault, Unavailable. A part with `simulated: true` also says "Simulated". A reported part not in the configuration says "Not in your setup". On the drawing, where several parts share one module (left and right hand controls), the module is drawn in the worst of their states (fault, then unavailable, then degraded, then simulated, then healthy) and its label lists each part's state, with "Simulated" on each simulated one. Labels arrive with their parts on first load; after that, a label that reappears (a resize or zoom across 560 px) shows at once. A healthy real part is drawn in solid green ink, a simulated one in dashed green (never solid), a degraded one in ink, a faulty one dashed in red, and an unavailable one as a faint dotted outline; the drawing is hidden from screen readers and its caption says the same in words.
- **Alert settings:** the configuration's cues by name (Vibration in the handles, Spoken messages, Short sounds), its version, and:
  - "Applied" only when `applied_configuration_version === configuration.version`;
  - "Waiting for the walker" otherwise, including when `applied_configuration_version` is null, lower, or higher.
- **Obstacles** (from `zones`): each zone by name ("Front", "Front left"):
  - `measured`: the distance ("38 cm", or "1.2 m" from 1000 mm) and its age ("0.6 s ago"), where the age keeps growing between polls (the response's `age_ms` plus the time since that response arrived). Once that age passes 8.5 s (the contract's 7 s freshness limit plus one poll), it shows as "Unknown" with "reading too old";
  - `unknown`: the word "Unknown" and why ("no reading", "the sensor couldn't measure", "reading too old"). Never "clear", "nothing", or "no obstacle", anywhere on the page.
  - "Simulated" next to every zone with `simulated: true`, measured or not.
  - No zones: "No obstacle sensors reporting."
- **Conversation**, oldest first, turns (`created_at`) and walker lines (`at`) merged by time:
  - a walker turn heard by Gemini: "You said (as heard by Gemini)" and the words;
  - a page turn: "You typed" and the words; a typed walker turn: "Typed on the walker";
  - `heard: null`: "Steady didn't catch that" in place of the words;
  - the reply beside Steady's mark;
  - `answered_by: "fixed"`: a quiet "Answered by the fixed replies" under the reply; nothing for `model`;
  - `voiced_by: "cartesia"`: "In Cartesia's voice"; `"walker"`: "In the walker's own voice"; `null` (page turns): nothing. (A replayed walker turn can say Cartesia although the walker spoke it itself; the contract records the voice offered, so this edge stays.) (The field records the voice the server offered, not what played, so the label names the voice, not a claim that it played.)
  - a walker line: "On the walker" and its text; a `local_reply` adds "offline reply".
  - Nothing yet: "Nothing said yet. Hold Talk on the walker, or type below."
- **Open proposal:** a card with the server's summary (large), "Now: …" and "After: …" cue lists, a countdown "Expires in 0:42" that is not announced each second, and two real buttons, **Confirm** and **Decline**, each described by the summary.
  - Confirm sends `POST /api/v1/walkers/{id}/proposals/{proposal_id}` with `{"answer":"confirm"}`; Decline with `"decline"`. Both lock while it waits.
  - One rule for every way an offer closes (answered here, answered on the walker, replaced, out of time): the card's heading always names its state ("Steady offers: Expired. Nothing changed."), and when the buttons go with focus on them, focus moves to that heading, which reads the outcome. The live region reads a closing unless focus is on the card's buttons (whose removal moves focus to the heading), so it's read exactly once: a person resting on the heading of a still-open card hears it from the live region, and an outcome for a walker no longer shown isn't read. Outcomes: "Confirmed. Switching your alerts to …" / "Declined. Nothing changed." / "Expired. Nothing changed." / "Replaced by a newer offer."
  - When the countdown reaches 0 before anyone answers: the buttons go away and the card says "Time's up: this offer can't be answered here any more." until the next status says how it ended. (The server owns expiry, and the page can't know from its own clock that nothing changed.) With focus on the buttons at that moment, the heading reads "Time's up…", and the next poll's "Expired. Nothing changed." is read too: the second line is the server's word that nothing changed, which the page's countdown can't say.
  - When the open proposal disappears without the page answering it: "Confirmed. Switching your alerts to …" if the configuration moved to `base_configuration_version + 1` with the proposal's cues; "Replaced by a newer offer." if another proposal is open; "Expired. Nothing changed." only if the configuration is still at `base_configuration_version` and its time is up or the walker is offline; otherwise "No longer open."
  - A closed card stays until a newer turn arrives; if focus is in it when it goes, focus moves to the text box.
  - A newer offer replacing the one on screen is a new card: focus on the old card's buttons (removed with it) moves to the new card's heading, but focus the person moved away from the card (even to the page background) stays where it is, never onto a Confirm button for an offer the person hasn't read. An error from answering one offer doesn't carry over to the next.
- **Forget this walker:** a button that opens a modal dialog, "Forget <name>?", saying that it deletes the walker's conversation, settings and offers now and that the walker must be paired again. **Keep it** (focused first) closes it; Escape closes it; **Forget** sends `DELETE /api/v1/walkers/{id}` and, on 204 (or 404, already gone), announces "Forgot <name>." and shows the next walker or "Connect a walker". The dialog belongs to the walker it was opened for: if the shown walker changes while it's open, it closes without ever showing another walker's name, and an old error doesn't show when it opens again.
- Several walkers: a labelled "Walker" picker; the page shows one at a time.
- **Connect another walker** (a quiet button under the name) shows the pairing panel as "Connect another walker" with "Back to <name>"; focus moves to its heading. When the new walker pairs, the page selects it and focus moves to its name. This is where `409 walker_limit` can come from.
- **Parts list vs labels:** where the drawing is at least 560 px wide, each part's label on the drawing carries its name, health and a "Simulated" chip, and the separate parts list is hidden; narrower, the labels go and the parts list shows. The drawing's caption says the same to screen readers at every size.

### Not live (polls failing)
- Every request has a deadline (polls 5 s, typed questions 20 s, everything else 10 s), so a stalled request reads as a failure instead of freezing the page.
- After about 5 s without a successful poll, the live region says once "Lost the connection to Steady's server. What's on screen may be out of date." and, when a poll succeeds again, "Connected to Steady's server again." Also, the status says "Can't reach Steady's server. Showing what it said <n> s ago." The online word becomes "Status unknown", every zone shows "Unknown" with "no update from the server", the drawing and its details are dimmed and grey, and the proposal's buttons stay, but a failed answer says so. When a poll succeeds again, the warning and the dimming go.
- **Fits one screen:** at 1440 x 900 with an offer open, the whole paired page is visible without scrolling.

## Typed questions
- Above the box, on screen before anyone types, exactly: "Your words go to Google's Gemini, which may keep a copy, and the text of Steady's spoken replies goes to Cartesia. Please don't type names or health details. Each message is deleted an hour after it's sent, or right away with Forget this walker." The box is described by it.
- Enter or the Send button sends `POST /api/v1/walkers/{id}/turns` with `{"client_turn_id": <new uuid>, "input": {"type":"text","text": <trimmed>}}`. Empty or space-only text sends nothing. Text is limited to 500 characters.
- While waiting: the person's words show as "You typed", Steady's mark breathes, Send is locked, focus stays in the box.
- On success: the box clears and the turn appears from the response's status. On failure: the words go back in the box, the error shows, and sending the same words again reuses the same `client_turn_id` (so a reply that did arrive isn't run twice).

## Live updates
- `GET /api/v1/walkers` every 1.5 s while the tab is visible; none while it's hidden; one at once when it becomes visible again. Polls never overlap, and a poll that started before a Confirm, Decline, send or Forget answered never overwrites what that answer returned.
- After an outage, "Connected to Steady's server again." is read before any news from the same poll, never overwritten by it.
- Older browsers without `AbortSignal.any` still get deadlines (a timer aborts the request), so the page loads there too.
- An action's answer for a walker no longer in the list is ignored (it never brings a forgotten walker back), and a poll starts right after each action so an older action answer is corrected at once. An answer for a walker other than the one now shown never puts its offer card on the shown walker.
- A polite live region announces, once each: every new reply ("Steady: …"), every new walker line ("On the walker: …"), every new open proposal ("Steady offers: <summary>. Confirm or decline within a minute."), going offline ("Your walker went offline."), coming online ("Your walker is online." the first time the page sees it online, as right after pairing; "Your walker is back online." after that), and a new configuration becoming applied ("Your walker applied the new alerts."). What was already there when the page loaded is not read out.

## Errors, in plain words
| What happens | What the page says and does |
| --- | --- |
| `401 unauthenticated` (any route) | Back to "Connect a walker", with "This browser isn't connected to a walker any more. Connect one again." |
| `404 not_found` (a walker route) | "<name> isn't connected to this browser any more." and the list is fetched again |
| `409 proposal_closed` | The card shows the proposal as the error carries it ("Confirmed …", "Declined …", "Expired …", "Replaced …") |
| `409 walker_limit` | "You already have 8 walkers. Forget one before connecting another." |
| `429 pairing_locked` | "Too many wrong codes were tried from this network. Wait 10 minutes, then get a new code." |
| `429 rate_limited` | "Too many requests. Wait a moment and try again." |
| `400 invalid_request` | "The server didn't accept that. Try again." (the typed words stay) |
| `503 unavailable` | "Steady's server isn't available right now. Try again in a moment." |
| Network failure | "Can't reach Steady's server. Check the connection." (and the not-live state above after 5 s of failed polls) |
| A 404 that isn't one of the contract's errors (a route this server doesn't have yet, such as typed questions before the assistant turn lands) | "Steady's server can't do that yet." (the typed words stay) |
| Any other response that doesn't match the contract | Treated as "unavailable"; never shown half-parsed |

## Accessibility
- Every control is a real button, link, input or select with a visible label or a name matching it, reachable by Tab in reading order, with the 3px focus ring.
- One polite live region (above); the countdowns use `role="timer"`, which is never announced on its own.
- The layout holds at 200% zoom (1440 → 720 CSS px wide) and at 390 px: nothing cut off, no sideways scroll.
- Reduced motion: no pen, the drawing appears already drawn, no word-by-word reveal, and the contour field is still.
- The words Simulated, Unknown, Offline, Online, Applied and Waiting for the walker are always on screen where they apply; nothing depends on colour alone.

## Development fake
- `/walker?fake=1` in development (never in production) uses a typed fake of the page API with the same interface as the real one, a "Fake walker: development only, nothing here is live" banner across the top, and a "Fake walker controls" panel to pair, speak a walker line, go offline or online, confirm on the walker, expire the offer, and make the next request fail with each error above. Without `?fake=1`, the page uses the real routes.
