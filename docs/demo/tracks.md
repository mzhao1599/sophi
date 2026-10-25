# Sophi for each sponsor track

This page is for the presenter and for whoever writes the Devpost submission. For each sponsor track Sophi enters, it says what the judges score, what Sophi really shows today, a 2-minute cut that opens on that track's moment, and the proof to bring. The [main demo script](script.md) stays the source for Wren's lines, the setup checklist and the honesty lines, and the [walker script](walker-script.md) for the walker's beats; this page only reorders and frames them.

**Status, 2026-10-24.**
- **Real today:** the onboarding website (conversation, the walker drawing, "Your walker", save, and an order in Stripe's test mode), and the walker assistant's server on Render (<https://sophi.work>, also at <https://steady-walker.onrender.com>), checked end to end on 2026-10-23, including a reply in Cartesia's voice.
- **Built and rehearsed on the walker simulator:** the walker's six beats ([walker-script.md](walker-script.md)) with the "Your walker" live page. Its "Behind the scenes" panel was checked on 2026-10-23 against a local production build with the simulator, a live model (the server's earlier one, before Claude) and Cartesia: every time it drew matched the server's own record.
- **On the real walker so far:** a Raspberry Pi 5 running the walker service with a USB microphone, a USB soundbar and Piper. On 2026-10-23 one real spoken turn ran on it ("What can you help me with?", answered by the server's earlier model 3.96 seconds after Talk was let go, heard through the soundbar in Cartesia's voice), and Max felt the handle buzz on a Talk press. On 2026-10-24 both hand boards said hello to the Pi and it logged "Sophi is on."; nobody has yet pressed both buttons to check which is Talk and which is Confirm. Not yet run on the walker: Confirm, an obstacle board, the six beats in order, and the venue's Ethernet.
- **Built during the event, not yet on the walker:** the walker's 5-inch screen (simulator only), the two-phone app (live on Render, tested in a headless browser, not yet on real iPhones), `walker check` (fakes only), the arm servo driver (no servo yet), the arm and lift motion safety contract, and, merged on 2026-10-24, the Pi's motion coordinator for the arms and the lift (taught skills, "Let go?", the screen's hold control) and the lift's firmware. The coordinator is tested only against simulated servos and a simulated lift board, and the firmware only on a computer. Nothing has moved a real arm or the lift. Each is in [Built during the event](#built-during-the-event) with how far it was tested.

Nothing below presents a planned part as working; each cut that needs a planned or untested part says so.

**Which tracks, and why.** The sponsor-track analysis (2026-10-23) ranked four tracks plus one free entry: Microsoft's "Built for the Real World" (and its Customer Impact Award), Visa's "Reimagining Shopping", Cartesia's voice track, Anthropic's track, and a free MLH entry for Google's model API, dropped on 2026-10-25 when Sophi moved all its model work to Claude. On 2026-10-24 Max asked to enter as many more as fit cheaply; [More entries](#more-entries-added-2026-10-24) adds five Cal Hacks prizes, four more MLH categories and Meta's track, and says why the rest are skipped.

| Entry | Cost | Section |
| --- | --- | --- |
| Microsoft: Built for the Real World, and its Customer Impact Award | In the plan | [Microsoft](#microsoft-built-for-the-real-world) |
| Visa: Reimagining Shopping | In the plan | [Visa](#visa-reimagining-shopping) |
| Cartesia | In the plan; a key and that day's check | [Cartesia](#cartesia-best-use-of-cartesia-only-with-a-key-and-heard-working-that-day) |
| Anthropic | In the plan; a Claude key and a rehearsal | [Anthropic](#anthropic) |
| Cal Hacks: Best Hardware Hack | Free | [Hardware](#cal-hacks-best-hardware-hack-free) |
| Cal Hacks: Best People-First Hack | Free | [People-First](#cal-hacks-best-people-first-hack-free) |
| Cal Hacks: Most Technically Complex Hack | Free | [Technically Complex](#cal-hacks-most-technically-complex-hack-free) |
| Cal Hacks: Hacker's Choice, and Most Creative Hack | Free | [Hacker's Choice and Most Creative](#cal-hacks-hackers-choice-and-most-creative-hack-free) |
| MLH: Best Use of Gen AI | Free | [Gen AI](#mlh-best-use-of-gen-ai-free) |
| MLH: Commit Fellowship | Free, plus a supplemental form | [Commit Fellowship](#mlh-commit-fellowship-free-plus-a-form) |
| Meta: Bringing People Closer Together with AI | Small: framing, and the phones on stage | [Meta](#meta-bringing-people-closer-together-with-ai-small) |
| MLH: Best Domain Name from GoDaddy Registry, and Best .Tech Domain Name | Small: register a domain for each, point them at Render | [Domains](#mlh-the-two-domain-name-categories-small) |
| Spacetime: core real-time backend | Built and live on Render 2026-10-24: the care circle on SpacetimeDB | [Spacetime](#spacetime-the-care-circle-on-spacetimedb-added-2026-10-24) |

## Before submitting (all tracks)

- **Say when the work started.** Cal Hacks 13.0's FAQ says "all implementation must occur during the hackathon". Max said on 2026-10-23 that Sophi is already cleared under this rule. The submission still says plainly that work began on 2026-10-23 and lists what was built during the event (the list below), because the demo never hides anything from judges.
- **Pick each track on Devpost** at submission, plus the MLH categories and the Cal Hacks prizes in the table above. Ask in the event Slack's #0-ask-directors (where the event FAQ sends questions; the FAQ itself didn't load on 2026-10-24) how many prizes one project may enter, and whether the Cal Hacks prizes need opting in. Nothing in the Microsoft or Anthropic track text excludes the other, so enter both unless the event caps entries. If it does, rank them on that day's state: Anthropic only once Claude has run live and rehearsed 3 of 3, otherwise Microsoft.
- **Outward steps are Max's:** creating sponsor accounts, pasting keys, posting the submission and any public link.

## Built during the event

For the Devpost text. Cal Hacks runs October 23 to 25, 2026. Everything here was merged to `main` on 2026-10-23 or later; #59 and #60 were merged that morning (10:40 and 11:04 PDT), and the rest from 22:42 PDT that night. Check them against the official start of hacking before posting, and move anything merged before it into the "before the event" line. Each item says how far it was tested. Render deploys `main` automatically, so every merged PR below is deployed there; the server's health check carries no version, so that is from the auto-deploy, plus the circle route seen live after #68.

- **A backup model for the walker assistant** (#59). Two models are asked at once, and the backup answers when the main one is slow. Built and measured locally with the server's earlier models, without voice; since 2026-10-25 the pair is Claude Haiku 5.5 and Claude Opus 5.5, not yet measured. Deployed by Render's auto-deploy of `main`, not measured on Render or the Pi.
- **Sophi never says the way is "clear" or "safe"** (#60). The server checks every reply in the model's own words and retries one that says it. Same testing as above.
- **The name Sophi, "A physical augmentation walker."** (#61), on the website, the walker page, the walker's spoken lines and the model prompts.
- **The venue network plan** (#62): the Pi on the venue's Ethernet, since Cal Hacks bans hotspots, and the offline beat done by unplugging the cable at the Pi. Written down; not yet run on the Pi.
- **`walker check` and a flash script** (#64): one read-only command that checks the Pi, its network, pairing, audio, voice, boards and screen, and a script that flashes an ESP32 board from the Pi. Tested only with fakes on a Mac; not yet run on the Pi or a real board.
- **The walker's 5-inch screen** (#63 and #65 the contract and drawing, #66 the full-screen kiosk, #70 the walker serving its own live screen): "Listening" while Talk is held, "One moment", the reply as captions, "Done", an obstacle, offline. Run in the walker simulator under headless Chromium at 800 by 480; not yet on the Pi or the panel.
- **The two-phone app at `/app`** (#68 the server, #69 the app): her simple mode with three big tiles, the caretaker's phone, short messages, a caretaker joining only after the owner's page approves it with a consent line, and "People nearby" as labelled sample data. Tested in a headless browser against the real routes on a local server, three runs in a row. Deployed by Render's auto-deploy of `main`: after #68 the circle route answered live on Render (its own 401 error), and after #69 `/app` served the app (title "Sophi"). Not yet run on real iPhones.
- **The arm servo driver** (#67): the Pi's driver for the arms' Feetech servos, byte-identical to Feetech's own SDK on 122 operations. Tested on a Mac only; it hasn't touched a servo.
- **The arm and lift motion safety contract** (#71): motors start only when a person at the walker acts (a Confirm press on the handle), the lift moves only while a person holds the screen's hold control, and a latching hardware stop is specified to cut the arms' power and the lift's step signal. Schemas and tests only (the stop isn't wired yet); nothing has run on the real arms or lift, and every limit is a placeholder until measured.
- **Both hand boards on the Pi** (Cooper's commit `7a4126c`, 2026-10-24): the Pi now finds both boards, and both said hello and were healthy; the Pi also ran from the walker's battery (its power draw isn't measured). Which button does what still needs a press check.
- **The lift board's firmware** (#74): the lift's ESP32 (`lift-01`) runs the lift only while each heartbeat from the Pi names the held request, stops on the stop switch, an end switch or 300 ms without a heartbeat, homes in four phases, and never resumes a stopped request. Tested on a computer only (unit tests and a session transcript against the contract); it builds for the ESP32, but hasn't run on the lift's ESP32, driver, motor or switches.
- **`walker check` for the arms, the lift, the stop switch and the cameras** (#75): read-only checks that never move or command anything. Tested with simulated arms and a simulated lift board on a Mac; not yet run on the Pi or any of that hardware.
- **The Pi's lift client and a simulated lift board** (#76): the Pi's side of the lift's serial lines, and a simulated board ported from the firmware's logic, with fault injection. Tested on a Mac against the simulated board only.
- **The Pi's motion coordinator for the two arms** (#77): a motor starts only on a Confirm press at the walker's handle, any handle press stops it, and the coordinator acts only on what it read back from a servo; with calibration, named poses, copy mode and a simulator. Tested only against simulated servos.
- **Motion on the walker's screen, and the lift's hold control** (#79): the pending Confirm target, what moves and how to stop it, faults, bench mode, and the lift's large "Hold to raise" control, which must stay held for the lift to move (a finger, or Space or Enter). Screenshots in headless Chromium at 800 by 480, and a hold check in a real browser on a Mac (3 of 3); not yet on the Pi or the panel.
- **Taught arm skills and "Let go?"** (#80): record a movement with the teaching arm, replay it after a Confirm press, and open the gripper only when the person holding the object presses Confirm, even after a fault. Tested only against simulated servos; the demo's tray task hasn't been taught.
- **The lift wired into the motion coordinator** (#85): a lift target is prepared at the terminal and starts only on a handle Confirm press while someone holds the screen's hold control and both arms are folded; letting go, any handle press, the stop switch or any fault stops it, and it never moves without the hardware stop. Tested on a Mac against the simulated lift board and simulated servos, including the demo's lift flow in real time 3 of 3; it has never talked to the real lift.
- **The walker demo script for the screen, the phones and the arms** (#83). Documentation only.
- **The care circle on SpacetimeDB** (branch `spacetime-care-loop`, 2026-10-24): the phones, codes, approvals and messages in a SpacetimeDB module (`services/care-db`), the server calling its procedures, and the phones and the owner's page getting each change pushed live. Tested against a local SpacetimeDB 2.13 (the 20 circle tests, 6 WebSocket view tests) and in a production build with Postgres, two phones and the owner's page in one browser, 3 of 3. Published to Maincloud as `sophi-care` and live on Render since 2026-10-24 (three Render runs in a row); not yet on real iPhones.
- **Test fixes after direct pushes to `main`** (#78, #81, #82, #84): the tests and shape snapshots caught up with Cooper's pushes for opt-in GPS sharing, the location and distance tools, the weather tool and the walker's tool loop. Tests only; those features' own testing isn't recorded on this page.

Before the event (2026-10-23 to the morning of 2026-10-23): the website and its Stripe test checkout, the onboarding agent, the walker assistant and its server on Render, the "Your walker" page and its "Behind the scenes" panel, the Pi service and its simulator, the ESP32 firmware, and the Pi's first run on 2026-10-23.

## Microsoft: Built for the Real World

**What the judges score:** customer understanding, measurable usefulness, a path from prototype to production, responsible design, and end-to-end functionality. The challenge asks for "a production-minded AI agent that solves a meaningful problem in finance, productivity, healthcare, or another high-impact domain". The track text doesn't require Microsoft products; ask at the Microsoft booth.

**What Sophi shows today:**
- **The website:** the whole [3-minute script](script.md#the-3-minute-script). Its "real-world" points are made by the product itself: no diagnosis asked, a "no" recorded as a no, fixed rules (not the model) choosing modules, a note under each reply saying who read it, a fallback that says so, a privacy notice before anyone types, keyboard access, and test-mode checkout with honest labels.
- **The walker, every day after** (rehearsed on the simulator; one turn on the real Pi): the model can only offer a change, nothing changes until a person presses Confirm, the page says "Applied" only when the walker reports it, and "Behind the scenes" draws each step of a turn with the server's own times ("Times are measured.").
- **The care loop on two phones** (built during the event and live on Render; tested in a headless browser, not yet on real iPhones). The names are made up: Rose walks with the walker, Maya is her caretaker.
  - Rose's phone is a simple mode, built the Assistive Access way: three huge tiles (My walker, Message Maya, People nearby), no typing, and "To change your alerts, ask Sophi on the walker." Her "My walker" screen also has her location-sharing switch, "Share my location with approved caretakers", which starts off and only her own phone can turn on. Maya's message is read aloud by the phone only when Rose taps it, and she answers with one tap ("I'm okay", "Can you call me?", "I'm on my way").
  - Maya's phone shows whether the walker is on, the alerts in force, part health, "Battery: not measured on this walker", and a thread of messages of up to 30 characters each.
- **Consent design in the care loop:**
  - The owner adds each phone from the walker page with a one-time 6-digit code. A caretaker's phone waits until the owner approves it, and Approve works only once this line is ticked: "Rose agreed that Maya can see whether the walker is on, its part health and alerts, exchange short messages with her, be told when she asks for help, see a recent GPS position only if location sharing is turned on later, and watch the walker's camera live only while camera sharing is on."
  - The caretaker never sees Rose's conversation with Sophi, the walker's own lines, its obstacle readings, or when she used it, and sees the walker's latest GPS position only if Rose turns location sharing on.
  - Messages are deleted 24 hours after sending, and at once when a phone is removed.
  - "People nearby" is fixed sample data with a "Sample" tag and "Sample people for the demo. This list does not use GPS or anyone's real location." No location is read for it.
  - **Honest limits to say if asked:** the caretaker is approved on the owner's page after asking Rose, not by Rose's own Confirm on the walker; the consent is checked, not stored, so there is no record of who agreed or when; and a caretaker can't suggest an alert change (Maya sends a message, and Rose asks Sophi herself).

**Three things to add to the pitch (the weak criteria):**

1. **Customer understanding.** Talk to one person who knows walkers: someone who uses one, a physical or occupational therapist, or a family caregiver. Ask first whether they agree to be quoted and how they'd like to be named (a first name, a role, or not at all). Show them the website, let them type their own answers if they want to (only on the deterministic engine, or on Claude once Anthropic's data terms are checked), and ask:
   - "Do these questions make sense for someone choosing a walker?"
   - "What would you want it to ask that it doesn't?"
   - "Which of these parts would you never want, and why?"
   - "What would make you trust it, or not?"

   Write down what they said and what you'd change, with their consent, in the table below. Quote only what they agreed to, with no medical details. If nobody can be found, the pitch says "we haven't tested it with walker users yet; that's next", which is what the Q&A already says.

   | Date | Who (as they agreed to be named) | Consent to quote | What they said | What we'd change |
   | --- | --- | --- | --- | --- |
   | Not done yet | | | | |

2. **Measured usefulness.** Say only measured numbers, each with when and how it was measured.
   - Measured on 2026-10-24 (rehearsal, real Claude Opus 5.5, laptop only): 39 model turns of Wren's lines, no fallbacks, 1.9 to 5.1 seconds a turn, median 2.5 seconds.
- Re-measure on the day, with nothing else running, using `REHEARSE_PROVIDER=anthropic pnpm --filter @walker/cloud-api rehearse` (see "Rehearse on a model" below). If turns take more than about 5 seconds, follow the script's "The agent is slow" fallback.
- The backup model cut the walker's slowest turn from 8.0 to 5.0 seconds in local tests with the earlier models; with Claude Haiku 5.5 and Claude Opus 5.5 it hasn't been measured yet.

3. **Path to production (15 seconds, in the close).** "What's built: continuous integration on every change, a live deploy, row-level security on saved setups, device authentication and versioned settings for the walker, a fallback for every model turn, a backup model when the main one is slow, and a written motion safety contract before any motor moves. What isn't: bench validation of the hardware, testing with walker users, a paid model tier for real people's words, and a regulatory review we haven't started."

**The 2-minute cut (the care loop):**

1. **0:00 to 0:37, setting it up:** the onboarding [60-second cut](script.md#the-60-second-cut) from 0:00 to 0:37: Wren's line, the walker drawing itself, Skip and "Show My Walker", and "You said" in the obstacle sensors' panel.
2. **0:37 to 1:10, the walker every day after:** the bridge line ("This is the walker every day after. It isn't Wren's: this one is Rose's, set up with voice on. Rose is made up too."), then the walker's [beat 4](walker-script.md#beat-4-change-a-setting-100-to-135): a spoken request, Sophi's offer, the Confirm press, "Applied". Point at "Behind the scenes": Claude, the rule, "Offer written by the server".
3. **1:10 to 1:40, the two phones,** both on cellular. Before judges arrive, link Rose's phone; just before the cut, have Maya's phone enter its code, so it shows "Waiting for the family to approve" (a waiting join lapses after 5 minutes). On the walker page's Phones card, tick the consent line ("Rose agreed that Maya can see…") and press Approve; Maya's phone opens. Maya sends "Dinner at six. I'll get you."; Rose's tile shows "1 new message", she taps it and her phone reads it aloud; she taps "I'm okay", and it appears in Maya's thread. "Rose's phone has three big tiles and no typing; to change her alerts, she asks Sophi on the walker. Maya got in only after the family ticked what Rose agreed to, and she sees whether the walker is on and how its alerts work, never what Rose says to Sophi."
4. **1:40 to 2:00:** the path-to-production line above.

Use step 2 only if the walker is running and was rehearsed that day. Use step 3 only once the app has run on two real phones against Render, three times in a row; until then, replace it with the website's "Your walker" beat (1:33 to 1:50 of the 3-minute script).

## Visa: Reimagining Shopping

**What the judges score:** innovation (25%), user experience (25%), technical execution (20%), commerce impact (15%), trust and responsibility (15%). The track text doesn't require a Visa API; ask at the Visa booth. If one is required, this track probably drops off the list.

**The line:** "Shopping for a mobility aid usually means reading parts lists. Here she says what's hard, the cart builds itself, every item can say why it's there in her own words, and the price counts only what she chose."

**What Sophi shows today:**
- The cart is built from her words, not from browsing: the walker drawing lights up suggested parts as she answers.
- Each part says why it's suggested, quoting her ("You said: …"), and a part she declined stays out, marked "You Said No".
- The most experimental parts (robot arms, arm lift) are never added by default; she switches them on herself.
- The walker sheet shows a running total beside the module count, for example "5 modules · $1,675 sample total", from the same table Checkout charges. Each switch's announcement reads the new total for screen-reader users.
- Stripe's checkout page lists each module with the catalog's one-sentence summary of what it does (never her own words, because Checkout data goes to Stripe), each name ending "(sample price)", and the page's note says "Prices are demo prices, not a real quote."
- Trust: Stripe test mode only (the server refuses live keys), placeholder prices labelled everywhere, no card form on our site, ids-only metadata, and a success page that says "Demo order: no money moved".

**Honest limits to say if asked:** nothing can really be sold (Sophi is a prototype, not a certified mobility aid), prices are placeholders, and we have no sales or conversion data.

**The 2-minute cut:** Wren's L1 (the cart starts building), L4 (her "no" stays out of the cart), "Show My Walker", one part's panel ("You said …"), switch on the arms and lift and point at the total changing, Save, Order (Demo), Stripe's page with the module summaries, pay with the test card, and end on "Demo order: no money moved".

## Cartesia: Best Use of Cartesia (only with a key, and heard working that day)

**What the judges score (25% each):** problem and originality; use of Cartesia (core to the experience; clear, responsive and natural voice); execution; impact and responsibility (accessibility, privacy, responsible use). Submission: a working demo, a 2-minute demo-first presentation, a short README (setup, Cartesia features used, known limitations), source access, and no keys in the repo. The README part is the section below; the Devpost text can link straight to it.

**Status, 2026-10-24:** built on `main` (#39). Max's key is in on Render. A spoken question to the deployed server came back in Cartesia's voice (4.1 s end to end, 2026-10-23), and the same night one spoken turn on the real Pi was answered in Cartesia's voice and heard through the walker's soundbar (3.96 s from letting go of Talk to the answer and its audio arriving). The simulator rehearsal ran before the key, so every reply there was spoken in the walker's own voice (`voiced_by: "walker"`, [walker-script.md](walker-script.md#rehearsal-results)). "In Cartesia's voice" under a reply on the page hasn't been recorded as seen in a run yet. Don't name Cartesia in a demo until a key is in and that day's run shows "In Cartesia's voice" under a reply. **Since commit `8f287f1` the server sent a `Cartesia-Version` that Cartesia's reference doesn't allow (fixed 2026-10-25, see the features list below), so the live checks above predate it: hear one reply in Cartesia's voice on Render after this fix is deployed before relying on it.**

**Why voice is core here:** a walker user's hands are on the handles. Talk is a button on the handle; the answer comes back out loud, and the same words appear on the "Your walker" page and, once it runs on the panel, as captions on the walker's own screen, so voice is never the only way to get them.

### Sophi and Cartesia (the README section for Cartesia's judges)

**What Cartesia does in Sophi:** it is Sophi's ears and voice on the walker. Hold Talk and ask a question; Cartesia's speech-to-text turns the clip into words; Anthropic's Claude writes the answer from those words; the server sends the answer's text to Cartesia's text-to-speech and returns the audio with the answer; the walker plays it. (Speech-to-text was added on 2026-10-25 and hasn't been run live yet.) The page notes under each reply which voice spoke it: "In Cartesia's voice" or "In the walker's own voice". Its "Behind the scenes" panel shows the voice step as "Sent in Cartesia's voice" with the time the server measured for it.

**Setup:**

1. Create a Cartesia account and an API key. When creating the account, file Cartesia's training opt-out (see "Max's steps" below).
2. Put the key in the server's environment as `CARTESIA_API_KEY`: on Render, **steady-walker → Environment** (the Blueprint in [`render.yaml`](../../render.yaml) asks for it); for a local server, `apps/web/.env.local`. Never in the repository, a commit or chat. Empty or `none` means no key: a Talk press then gets a fixed "I can't hear you right now" line, and the walker speaks with its own voice. `CARTESIA_VOICE_ID` may name another stock voice.
3. Restart the server, pair a walker (or run the Pi service's simulator against the server: [devices/pi](../../devices/pi/README.md)), hold Talk and ask "What can you help me with?". The page shows "In Cartesia's voice" under the reply, and the server's log line for the turn says `voiced_by=cartesia` with the voice's time in `voice_ms`.

**Cartesia features used** (checked against [Cartesia's API reference](https://docs.cartesia.ai/api-reference/tts/bytes) on 2026-10-23; code in [`speech.ts`](../../services/cloud-api/src/walker/speech.ts)):

- Speech-to-text, model `ink-whisper`, through `POST https://api.cartesia.ai/stt` with `Cartesia-Version: 2026-08-14` ([reference](https://docs.cartesia.ai/api-reference/stt/transcribe), read 2026-10-25), at most 2.5 seconds a clip. Built and tested with stubs; not yet run live.
- Sonic text-to-speech, model `sonic-3.6`, through `POST https://api.cartesia.ai/tts/bytes` with `Cartesia-Version: 2026-08-14`, the only value Cartesia's reference allows ([reference](https://docs.cartesia.ai/api-reference/tts/bytes), read 2026-10-25). A bulk date edit (commit `8f287f1`) had changed it to `2026-10-23`; it was put back on 2026-10-25 and hasn't been heard live since.
- A stock English voice, "Skylar" (`language: "en"`), one Cartesia recommends for voice agents. No voice is cloned.
- WAV output at 16 kHz, mono, 16-bit PCM: what the walker's player takes. The server checks the header before sending it on.
- Called from the server only, so the key never reaches the walker or the browser.

**How it behaves when something goes wrong:** the voice gets at most 3 seconds inside the server's 8-second budget for a turn (the walker gives up at 10). When the backup model answers after its 4.5-second switch-over, the voice still has its full 3 seconds. No key, an error, a slow answer, audio longer than about a minute, or audio the walker can't play: the answer comes back without speech, and the walker says it in its own voice (Piper or espeak-ng on the Pi). The walker's own fixed lines ("Sophi is on", "Nothing to confirm", "I'm offline right now…", "I need to be paired again") are written on the Pi. Since Cooper's commit `ec8b3d4` (2026-10-24) a paired Pi asks the server to say them in the same Cartesia voice (`POST /devices/{id}/speech`, no model call and no stored turn, a 3-second limit), and uses its own voice when that fails or there's no connection, so it still talks with no internet and offline lines can sound different. That route is in code; its live check is pending. Typed questions from the page are answered on the page and not spoken.

**Known limitations:**

- Heard live through the deployed server on 2026-10-23 (a spoken question answered in Cartesia's voice, 4.1 s end to end; two replies made in 0.9 and 1.3 s), and on the real Pi's soundbar for one turn the same night. The six demo beats haven't run on the real Pi, and "In Cartesia's voice" on the page hasn't been recorded as seen.
- On the simulator, without Cartesia, the reply's text reached the walker 1.9 to 4.6 seconds after Talk was released (median 2.7 seconds over 16 spoken turns; [walker-script.md](walker-script.md#rehearsal-results)). Cartesia's time, at most 3 seconds, comes on top of the server's part of that. The one real Pi turn took 3.96 seconds including Cartesia's time.
- The whole reply is made before it plays (the bytes endpoint, not streaming), so Cartesia's time adds to the wait after Talk is released. Streaming over Cartesia's WebSocket would start sooner; it isn't built.
- Captions on the walker's screen (built 2026-10-24) have run only in the simulator under headless Chromium, not on the Pi or the panel, and with the simulator's fake server, so "You said" and "Answered by …" on the screen have been drawn only from example states so far.
- English and one stock voice only.
- Needs the internet; offline, the walker uses its own voice.
- Data: Cartesia's terms (date reference normalized to October 23, 2026; revision date not reverified) let Cartesia use inputs and outputs to train its models unless the account opts out, state no retention period, and offer zero data retention only on enterprise plans. Since 2026-10-25 the voice clip goes to it too, for speech-to-text, along with Sophi's reply text. Until those terms allow real people's words and voices, only scripted, made-up lines go through it.

### Notice wording

- **The "Your walker" page** ([`walkerView.ts`](../../apps/web/src/lib/walkerView.ts)) says before anyone types who gets the words: Anthropic's Claude for what's typed and said, Cartesia for the voice clip and the text of spoken replies, that both may keep a copy, not to type names or health details, and that each message is deleted after an hour or with Forget this walker. Copy its exact words from the page before quoting it here.
- **A card on the walker** (printed, for the table): "Only the presenter talks to this walker. Cartesia turns what's said into words and speaks Sophi's replies, and Anthropic's Claude writes the answers; both may keep a copy. Want to try it? Type on the screen, and leave out names and health details."
- **Said aloud at the Talk beat:** "Cartesia hears the question and speaks Sophi's answer; Claude writes it."

### The 2-minute cut

Demo first, then the why. The beats and their exact lines are in the walker script, [`walker-script.md`](walker-script.md); this cut uses four of them.

1. **0:00 to 0:15, boot:** the walker says "Sophi is on." (in Cartesia's voice once the Pi's request for it is checked live, otherwise in its own voice; check which on the day), and the page shows "Online" with each part's health.
2. **0:15 to 0:40, ask:** Talk: "What can you help me with?" The answer comes back out loud in Cartesia's voice (in the model's own words), and the page shows "You said (as heard by Cartesia)", the reply, and "In Cartesia's voice". Say the line about where the text goes. Only if the walker's screen has been rehearsed on the panel that day (so far it has run only in the simulator): point at it as it goes "Listening", "One moment", then the reply as captions.
3. **0:40 to 1:15, change a setting:** Talk: "Stop buzzing me, use short sounds instead." Sophi says "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." (the server writes this line from the change itself). Press Confirm on the walker. It says "Done. Obstacle alerts now use short sounds.", and the page's alerts change to "Version 2", "Short sounds" and then "Applied" (2 to 9 seconds after Confirm in the rehearsal; keep talking meanwhile).
4. **1:15 to 1:35, offline:** unplug the walker's Ethernet cable at the Pi's end (never at the venue's switch; the walker's Wi-Fi backup must be off, see the walker script's setup B, step 3), and plug it back in to return. After about 6 to 10 seconds (on the simulator; unplugging hasn't been timed) the walker says, once, "I'm offline right now. Your short-sound alerts still work.", in its own voice, and a Talk press then gets the same line at once. "Cartesia speaks when it can; the walker never goes silent." On the simulator, cutting the network needs the walker script's setup checklist.
5. **1:35 to 2:00, why and how:** "Your hands are on the handles, so voice is how you ask. Push to talk, never a listening microphone. Cartesia hears and speaks, Claude answers, the walker's own voice covers offline, and every word is on the page too, for anyone who can't hear it."

**Max's steps:**

- Create the Cartesia account and key, and file Cartesia's training opt-out when creating the account.
- Paste the key into Render's environment as `CARTESIA_API_KEY`.
- Check the plan's terms. A third-party guide says the free plan is for personal, non-commercial use.
- Then run the cut once that day before mentioning Cartesia.

## Anthropic

**What the judges score:** a named community, a real problem ("you have lived it, or you talked to someone who has"), it works ("one thing done well and usable on Monday"), and thoughtful use of Claude ("Claude does something that matters to the solution, and you know where it could go wrong for the people using it").

**The named community (pick after the conversation in the Microsoft section):** for example "people who use a rollator around home and local shops and find small buttons hard to press".

**What Claude does in Sophi:** the onboarding agent was built for Claude first (`services/cloud-api/src/onboarding/anthropic.ts`: Claude Opus 5.5 at low effort, one structured-output call per turn, the server-side refusal fallback on). It reads the person's words as a fixed list of needs, picks the next topic from a fixed list and words the question, and writes a one-line acknowledgement. It never picks a module.

Since 2026-10-25 Claude answers every walker question too, typed or spoken (`services/cloud-api/src/walker/config.ts`): Claude Haiku 5.5, with Claude Opus 5.5 asked alongside as the backup. A spoken question reaches it as Cartesia's transcript, since Claude's API takes no audio. The server words every offer, only a Confirm press changes the walker, and "clear" or "safe" in a reply is retried. "Behind the scenes" names the model that ran each turn, from the server's own record.

**Where it could go wrong, and what Sophi does about it:** the model could misread a need (each part's panel quotes the words it came from, and every switch stays with the person); it could fail or be slow (a 15-second deadline, then the fixed questions, with a note saying so); it could be steered by what someone types (her words are passed as data, and fixed rules choose modules); and people's words leave the laptop (the notice names who reads them before anyone types).

**Status:** the key went into `apps/web/.env.local` on 2026-10-24. The first live run failed every turn in about 0.2 seconds: the adapter sent the beta header `server-side-fallback-2026-10-23`, which the API rejects. `fallbacks: "default"` needs `server-side-fallback-2026-07-01`, which fixed it. Measured on 2026-10-24 (rehearsal, real Claude Opus 5.5, laptop only): 3 runs, 9 of 9 paths passed, 39 model turns, no fallbacks, 1.9 to 5.1 seconds a turn, median 2.5 seconds. Steps 3 and 4 below haven't been done yet, and it hasn't run on Render.

**The walker on Haiku and Opus (2026-10-25):** typed turns, 3 runs plus fresh wordings, 15 of 15 checks passed, median 2.1 seconds, 0.8 to 4.3 seconds, the Opus backup used on none (details in `services/cloud-api/README.md`). Spoken turns through Cartesia's speech-to-text are not yet measured. The numbers below are from 2026-10-24, when typed walker turns ran on Claude Opus 5.5 alone and spoken ones on the server's earlier model.

**Typed walker turns on Claude, measured 2026-10-24** (the live walker suite, `WALKER_LIVE=1 WALKER_LIVE_MODES=text pnpm --filter @walker/cloud-api walker-live`, typed lines sent through the page as people type them, real Claude Opus 5.5, laptop only, no voice): 3 runs of beats 2 to 5 plus three fresh wordings and the all-parts-simulated check, every check passed, 15 turns all answered by Claude, 1.7 to 3.8 seconds a turn, median 2.2 seconds; one turn needed its one retry. Beat 3 typed on the page is answered by the server from the sensors ("The obstacle sensors read front: 64 centimetres…"), not in the model's words, by design. Then the whole suite, typed and spoken together (`WALKER_LIVE=1 pnpm --filter @walker/cloud-api walker-live`, same day, laptop only, synthetic voice from `say`, no Cartesia): every check passed on 3 runs of each. Typed on Claude: 15 turns, 1.8 to 2.9 seconds. Spoken on the earlier model: 15 turns, 2.0 to 8.1 seconds; the slow ones are the obstacle questions, which take two server requests (the model asks for get_distance, the walker continues, the model answers from the reading: 5.9 to 8.1 seconds for both together, in-process times), and one of them was answered by the backup model. All 30 turns: median 2.3 seconds. Not yet run on Render, the Pi or the page in a browser.

**Before mentioning Claude in the demo:**
1. Put `ANTHROPIC_API_KEY` in `apps/web/.env.local` (and on Render, where the walker uses it too). With the key the onboarding agent runs by default; `ONBOARDING_ENGINE=deterministic` turns it off.
2. Rehearse: `REHEARSE_PROVIDER=anthropic pnpm --filter @walker/cloud-api rehearse`. It must pass every path on all 3 runs with every reply from the model.
3. Rebuild and start as in the script's setup checklist. The notice must name "Anthropic's Claude", and each reply must say "Read by Claude". Mention Claude only after that check.
4. Check Anthropic's current commercial terms on retention and training, and update judge Q&A 1 and 2 in the script to match.

**The 2-minute cut:** the Microsoft cut, with the named community in the first sentence and the "where it could go wrong" answer in place of the path-to-production line.

## More entries (added 2026-10-24)

Max asked to enter as many tracks as fit cheaply. Each entry below reuses a cut that is already planned, so none adds work to the demo path; the "small" ones add a short framing or one outward step. Names, criteria and quotes are from the event's official prize page, <https://hive.hackberkeley.org/prizes> ("Updated Oct 24, 10:46 AM", pasted by Max on 2026-10-24); the page says prizes may still change, so check it again before submitting. Where a track's criteria weren't posted, the entry says so.

### Cal Hacks: Best Hardware Hack (free)

**Why Sophi fits:** it's a real rollator with a computer and sensors on it, not a laptop demo. Of every entry, this one depends most on what the walker does on the day.

**What to say, as measured** (see [current-build.md](../../hardware/current-build.md) and the status at the top):
- A Raspberry Pi 5 on the walker runs the walker service, from the walker's goBILDA battery through a 5 V converter (power draw not measured).
- Push-to-talk on the handle, a USB microphone and a soundbar: one real spoken turn answered in 3.96 seconds on 2026-10-23.
- Two ESP32 hand boards that both said hello to the Pi on 2026-10-24; a haptic buzz felt in the handle on a Talk press.
- A USB GPS that enumerates and sends valid sentences (no fix yet).
- Two SO-101 arms and a ball-screw lift (bought; say whether they're mounted only from what's on the walker that day), with a servo driver, a motion coordinator and lift firmware that so far have run only against simulated hardware. Say exactly that unless a real arm or the lift has moved, rehearsed, that day.

**What to show:** the walker cut (Cartesia's or Microsoft's step 2), on the real walker only. Hold the Talk button up so judges see the hand board; let a judge feel the buzz.

**Don't say:** anything about the arms, the lift, the obstacle sensors or the screen working on the walker until it has run there, nor any power, payload or tipping figure that wasn't measured.

### Cal Hacks: Best People-First Hack (free)

**Why Sophi fits:** it's an assistive walker that asks what's hard for the person (no diagnosis), suggests only the help they want, keeps their "no", and puts every essential action on a large button as well as voice.

**What to show:** the Microsoft cut. Open with the named community from the Anthropic section, and use the consent design in the care loop and the accessibility checks (keyboard, screen reader, large text, reduced motion) as the evidence. Say "we haven't tested it with walker users yet" unless the conversation in the Microsoft section has happened.

### Cal Hacks: Most Technically Complex Hack (free)

**Why Sophi fits:** it spans four kinds of computer, each with a clear job: ESP32 firmware (controls, sensors, haptic cues), the Pi service (coordinating devices, enforcing motion limits), the cloud server (the agent and the conversation) and the website (onboarding and setup).

**What to say, each with how far it was tested** (from [Built during the event](#built-during-the-event)):
- The walker assistant turns a spoken clip into words with Cartesia, answers with Claude (a main model and a backup asked alongside), and speaks in Cartesia's voice.
- The model is never motor authority. It can only offer an action by its id; the Pi writes the words and starts motion only on a Confirm press at the handle; the lift moves only while someone holds the screen's hold control.
- A Feetech servo driver checked byte for byte against Feetech's own SDK on 122 operations; a motion coordinator that acts only on what it read back from a servo; lift firmware that stops 300 ms after the Pi's heartbeat stops. All tested against simulated hardware only.
- A versioned contract package (`packages/contracts/`) that every component is tested against.

**What to show:** "Behind the scenes" on the walker page during any walker turn, then 20 seconds on the architecture diagram in [architecture.md](../architecture.md).

### Cal Hacks: Hacker's Choice, and Most Creative Hack (free)

Hacker's Choice: per its name, other hackers choose it, so the table matters more than the pitch. Keep the walker at the table with the printed card (see [Notice wording](#notice-wording)), let visitors type on the screen, and let them feel the handle buzz. Only the presenter talks to the walker.

Most Creative Hack: a long shot. Enter only if entries are free. The pitch line: "Most walkers are the same frame for everyone. Sophi asks what's hard, then builds only the help you want."

### MLH: Best Use of Gen AI (free)

**What it asks:** "utilize publicly available Generative AI APIs (like those from OpenAI, Anthropic, Hugging Face, Llama, IBM Watson, or Google Gemini) to develop a unique and functional application". Prize: assorted MLH prizes.

**What to say:** Claude reads her words in onboarding and answers the walker's questions, with a backup model; Cartesia turns her spoken clips into words and its generative voice speaks the replies (once that day's check passes); and the model only offers, while fixed rules and a Confirm press decide. Say only what has run live that day, as in the Anthropic and Cartesia sections.

### MLH: Commit Fellowship (free, plus a form)

**What it asks:** a working prototype built by a team, and a real problem worth solving. The prize is an interview for MLH and Transcend Network's 3-week zero-to-founder sprint.

**Max's steps:** opt in at Devpost submission, then fill in MLH's supplemental form, which the prize text says is required. The winner is picked after the event.

**What to put in the form:** the real problem (the named community), what works today (the status list at the top, unchanged), and the path to production line from the Microsoft section.

### Meta: Bringing People Closer Together with AI (small)

**What the judges score:** "how meaningfully they strengthen human connection, how essential and well-integrated AI is, originality, and the strength of the working demo". The prize is an invitation to a second-round hackathon at Meta's Menlo Park campus (subject to Meta's eligibility rules).

**The line:** "Rose wants to keep going out on her own. Her family wants to know she's okay. Sophi keeps them close without taking either away."

**What Sophi shows:** the care loop on two phones (the Microsoft cut's step 3): Rose's three big tiles, Maya's message read aloud when Rose taps it, a one-tap reply, and a caretaker who gets in only after the family ticks what Rose agreed to. The AI is Sophi on the walker, which answers Rose's questions out loud and offers changes she confirms herself.

**Honest limits to say if asked:**
- The messages between Rose and Maya are person to person; the AI isn't in them. That's the weak criterion. Put the AI's part plainly: it lets Rose ask for help with her hands on the handles, so she can keep going out alone, and the phones keep her family in the loop.
- "People nearby" is fixed sample data with a "Sample" tag, and must stay described that way.
- The app hasn't run on real iPhones yet. Enter this track only once it has run on two real phones against Render, three times in a row (the same rule as the Microsoft cut's step 3).

### MLH: the two domain-name categories (small)

**What they ask:**
- **Best Domain Name from GoDaddy Registry:** "Register your domain name with GoDaddy Registry". Prize: a digital gift card.
- **Best .Tech Domain Name:** the prize is a .tech domain "for up to 10 years" and a desktop microphone. The page gives no further rule; MLH's prize page (<https://www.mlh.com/events/prizes>) has the details.

These are two different registries, so entering both means two names, for example one `.tech` and one from GoDaddy Registry's endings.

**Cost:** MLH has given hackers free domains at its events before (for GoDaddy Registry, MLH's 2020 partnership announcement). This event's codes weren't found online on 2026-10-24, so ask at the MLH table for both before paying anything.

**Done so far:** `sophi.work` (registered at Porkbun on 2026-10-24) is connected to `steady-walker` and is the site's main address ([how](../../apps/web/README.md#the-address-sophiwork)). Which registry runs `.work`, and so whether it counts for either category, hasn't been checked.

**Max's steps:** pick the names (short, with "sophi" in them), register each with MLH's codes, and add both to the `steady-walker` service on Render as custom domains, following Render's instructions for the DNS records. Then open the website at each name once before submitting. Every link in the demo keeps working at the Render address too.

### Spacetime: the care circle on SpacetimeDB (added 2026-10-24)

**What they ask** (Cal Hacks prize page, read 2026-10-24): projects "where Spacetime is the core real-time backend, especially anything with live shared state, multiplayer interaction, or instant sync between users/agents/systems", naming chat and community apps and multi-user tools; "the main thing we'd want is for Spacetime to be meaningfully used, not just added on the side." Prizes: 1st 2,048 USD, 2nd 1,024 USD, 3rd 512 USD.

**The line:** "Rose's family and her caretaker share one live circle. Every join, approval and message is a SpacetimeDB transaction, and it reaches the other phones the moment it commits."

**What Sophi shows:** the care loop on two phones and the owner's page (the Microsoft cut's step 3), with the timing visible: Maya types her code, and the owner's page shows "Maya is waiting to join." at once; the owner ticks Rose's consent line and approves, and Maya's phone leaves "Waiting for the family to approve" by itself; Maya's message appears on Rose's phone as she sends it, and Rose's one-tap reply on Maya's. Then show the code: the module (`services/care-db/src/index.ts`), its per-phone views, and the dashboard at <https://spacetimedb.com/sophi-care>.

**What SpacetimeDB does here, exactly** (say it this way): it holds the circle's state (phones, codes, waiting caretakers, messages, wrong-code tries); each change runs in it as one transaction (the server calls one procedure per step); and each phone subscribes to its own views, which SpacetimeDB keeps current. The server still checks the cookies and the consent, and the walker's own data (pairing, turns, GPS) stays in Postgres.

**Honest limits to say if asked:**
- Writes go through Sophi's server, which checks who may do what before calling SpacetimeDB; the phones read live from SpacetimeDB.
- Measured on Render with Maincloud (2026-10-24, three runs in a row, Rose's phone in a browser, Maya and the owner as scripts with their own cookies and a real SpacetimeDB connection): approval reached Maya's open connection in 166 to 178 ms; Maya's message showed on Rose's screen in 456 to 458 ms when Rose's last poll was seconds earlier (787 ms in the run where a poll coincided, so that one may have come by the poll); Rose's reply reached Maya in 286 to 318 ms; removal emptied Maya's views in 150 to 272 ms. Say "under half a second", not "instant".
- The phones are in one browser for that check, not two real iPhones yet (the same rule as the Microsoft cut's step 3).

**Status (2026-10-24):** on Render. The four `SPACETIME_*` settings are set, `main` is deployed (`45433f7`), `GET /api/v1/health` shows `care_db: "ok"`, and the two-phone path passed three times in a row on Render, with nothing of the test walkers left in Maincloud. Phones linked before the switch join again with new codes. Render's auto-deploy didn't fire for the merges after the service was reconnected to `mzhao1599/sophi`; until that's fixed, deploy each merge by hand (Manual Deploy, Deploy latest commit). Still not done: real iPhones.

### Watch: Armadin, Elastic, AfterQuery and Annapurna Labs

Their criteria say "Coming soon!". Check them at the event. For Armadin's Best Security Hack: if the criteria are general, the story is Sophi's guardrails (the model offers an action only by id, the server or the Pi writes every word, a person confirms on the walker, and webpages, model output and typed words are data, never instructions); if they want an attack or a security tool, skip.

### Skipped, and why

- **A sponsor's product would have to become core, which means new work off the demo path:** Creao's AI-First Disruptor and Team Empowerment (criteria only on Creao's community page), Convex, Moss, Bitdeer AI, Factory (Droid must "do real work in the running product"), Fetch.ai, Apify and Bright Data (live public web data must be essential), Atlassian (both its tracks require building "a Forge app for one or more Atlassian products", per its rules document, read 2026-10-24), and MLH's Tiger Data, Vultr, Snowflake, Backboard, Auth0, DigitalOcean and MongoDB Atlas.
- **Dropped on 2026-10-25:** MLH's Best Use of Gemini API. Sophi no longer uses Gemini; Claude does all its model work.
- **Conflicts with the plan:** MLH's ElevenLabs (Sophi's voice is Cartesia, entered above; a second voice provider just for a prize would muddy that entry) and MLH's Presage (camera-based heart rate, breathing and emotion: sensitive health data that Sophi's consent rules keep out, and not on the demo path).
- **Finance, payments or crypto, which Sophi isn't:** Hyphenate, CRS, Capital One's Nessie, Coinbase's x402, MLH's Solana.
- **Requires a tool used to build the project, which Sophi wasn't built with:** Mana, Notability, Figma in the Workflow, SpaceXAI (built with Cursor, using Grok's Imagine or Voice API), and MLH's SpaceXSI A-Team raffle (Cursor and Grok Bot in the workflow).
- **The team doesn't match:** Best Beginner Hack, Best Solo Hack, Creao's One-Person Company. Best Planet-First Hack doesn't match the project.

## Rehearse on a model

`pnpm --filter @walker/cloud-api rehearse` runs Wren's lines through the real onboarding service in memory on the script's three paths (full, 3-minute, 60-second). Without `REHEARSE_PROVIDER` it runs the fixed questions only, which also run in CI on every change. With `REHEARSE_PROVIDER=anthropic` it also runs the model 3 times (`REHEARSE_RUNS` changes that), reading the key from the environment or from `apps/web/.env.local`, never printing it, and prints each turn, its time, and a summary such as "15 model turns, 0 fallbacks, 1.9 to 5.1 s, median 2.5 s". A path passes only if the topics come in the script's order, the right parts light after every line, the final walker matches, voice isn't suggested, the arms are "worth considering", and no turn fell back.
