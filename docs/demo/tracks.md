# Sophi for each sponsor track

This page is for the presenter and for whoever writes the Devpost submission. For each sponsor track Sophi enters, it says what the judges score, what Sophi really shows today, a 2-minute cut that opens on that track's moment, and the proof to bring. The [main demo script](script.md) stays the source for Wren's lines, the setup checklist and the honesty lines, and the [walker script](walker-script.md) for the walker's beats; this page only reorders and frames them.

**Status, 2026-10-24.**
- **Real today:** the onboarding website (conversation, the walker drawing, "Your walker", save, and an order in Stripe's test mode), and the walker assistant's server on Render (<https://steady-walker.onrender.com>), checked end to end on 2026-10-24, including a reply in Cartesia's voice.
- **Built and rehearsed on the walker simulator:** the walker's six beats ([walker-script.md](walker-script.md)) with the "Your walker" live page. Its "Behind the scenes" panel was checked on 2026-10-23 against a local production build with the simulator and live Gemini and Cartesia: every time it drew matched the server's own record.
- **On the real walker so far:** a Raspberry Pi 5 running the walker service with a USB microphone, a USB soundbar and Piper. On 2026-10-24 one real spoken turn ran on it ("What can you help me with?", answered by Gemini 3.96 seconds after Talk was let go, heard through the soundbar in Cartesia's voice), and Max felt the handle buzz on a Talk press. On 2026-10-24 both hand boards said hello to the Pi and it logged "Sophi is on."; nobody has yet pressed both buttons to check which is Talk and which is Confirm. Not yet run on the walker: Confirm, an obstacle board, the six beats in order, and the venue's Ethernet.
- **Built during the event, not yet on the walker:** the walker's 5-inch screen (simulator only), the two-phone app (live on Render, tested in a headless browser, not yet on real iPhones), `walker check` (fakes only), the arm servo driver (no servo yet) and the arm and lift motion safety contract (schemas only). Each is in [Built during the event](#built-during-the-event) with how far it was tested.
- **In progress, not merged:** the arms and lift coordinator on the Pi, and the lift's firmware. Nothing on the walker can move an arm or the lift.

Nothing below presents a planned part as working; each cut that needs a planned or untested part says so.

**Which tracks, and why.** The sponsor-track analysis (2026-10-24) ranked four tracks plus one free entry: Microsoft's "Built for the Real World" (and its Customer Impact Award), Visa's "Reimagining Shopping", Cartesia's voice track, Anthropic's track, and MLH's "Best Use of Gemini API". The others don't fit without work off the demo path or against the project's safety and consent rules.

## Before submitting (all tracks)

- **Say when the work started.** Cal Hacks 13.0's FAQ says "all implementation must occur during the hackathon". Max said on 2026-10-24 that Sophi is already cleared under this rule. The submission still says plainly that work began on 2026-10-23 and lists what was built during the event (the list below), because the demo never hides anything from judges.
- **Pick each track on Devpost** at submission, plus the MLH Gemini category. Ask at the event how many prizes one project may enter.
- **Outward steps are Max's:** creating sponsor accounts, pasting keys, posting the submission and any public link.

## Built during the event

For the Devpost text. Cal Hacks runs October 23 to 25, 2026. Everything here was merged to `main` on 2026-10-23 or later; #59 and #60 were merged that morning (10:40 and 11:04 PDT), and the rest from 22:42 PDT that night. Check them against the official start of hacking before posting, and move anything merged before it into the "before the event" line. Each item says how far it was tested. Render deploys `main` automatically, so every merged PR below is deployed there; the server's health check carries no version, so that is from the auto-deploy, plus the circle route seen live after #68.

- **A backup model for the walker assistant** (#59). Two Gemini models are asked at once, and the faster one answers when the main one is slow; measured numbers are in [the MLH section](#mlh-best-use-of-gemini-api-free-entry). Deployed by Render's auto-deploy of `main`; measured locally on real Gemini, without voice, and not measured on Render or the Pi.
- **Sophi never says the way is "clear" or "safe"** (#60). The server checks every reply in the model's own words and retries one that says it. Same testing as above.
- **The name Sophi, "A physical augmentation walker."** (#61), on the website, the walker page, the walker's spoken lines and the model prompts.
- **The venue network plan** (#62): the Pi on the venue's Ethernet, since Cal Hacks bans hotspots, and the offline beat done by unplugging the cable at the Pi. Written down; not yet run on the Pi.
- **`walker check` and a flash script** (#64): one read-only command that checks the Pi, its network, pairing, audio, voice, boards and screen, and a script that flashes an ESP32 board from the Pi. Tested only with fakes on a Mac; not yet run on the Pi or a real board.
- **The walker's 5-inch screen** (#63 and #65 the contract and drawing, #66 the full-screen kiosk, #70 the walker serving its own live screen): "Listening" while Talk is held, "One moment", the reply as captions, "Done", an obstacle, offline. Run in the walker simulator under headless Chromium at 800 by 480; not yet on the Pi or the panel.
- **The two-phone app at `/app`** (#68 the server, #69 the app): her simple mode with three big tiles, the caretaker's phone, short messages, a caretaker joining only after the owner's page approves it with a consent line, and "People nearby" as labelled sample data. Tested in a headless browser against the real routes on a local server, three runs in a row. Deployed by Render's auto-deploy of `main`: after #68 the circle route answered live on Render (its own 401 error), and after #69 `/app` served the app (title "Sophi"). Not yet run on real iPhones.
- **The arm servo driver** (#67): the Pi's driver for the arms' Feetech servos, byte-identical to Feetech's own SDK on 122 operations. Tested on a Mac only; it hasn't touched a servo.
- **The arm and lift motion safety contract** (#71): motors start only when a person at the walker acts (a Confirm press on the handle), the lift moves only while a person holds the screen's hold control, and a latching hardware stop is specified to cut the arms' power and the lift's step signal. Schemas and tests only (the stop isn't wired yet); nothing has run on the real arms or lift, and every limit is a placeholder until measured.
- **Both hand boards on the Pi** (Cooper's commit `7a4126c`, 2026-10-24): the Pi now finds both boards, and both said hello and were healthy; the Pi also ran from the walker's battery (its power draw isn't measured). Which button does what still needs a press check.
- **In progress, not merged:** the arms and lift coordinator on the Pi, and the lift's firmware. Describe these only as in progress.

Before the event (2026-10-23 to the morning of 2026-10-23): the website and its Stripe test checkout, the onboarding agent, the walker assistant and its server on Render, the "Your walker" page and its "Behind the scenes" panel, the Pi service and its simulator, the ESP32 firmware, and the Pi's first run on 2026-10-24.

## Microsoft: Built for the Real World

**What the judges score:** customer understanding, measurable usefulness, a path from prototype to production, responsible design, and end-to-end functionality. The challenge asks for "a production-minded AI agent that solves a meaningful problem in finance, productivity, healthcare, or another high-impact domain". The track text doesn't require Microsoft products; ask at the Microsoft booth.

**What Sophi shows today:**
- **The website:** the whole [3-minute script](script.md#the-3-minute-script). Its "real-world" points are made by the product itself: no diagnosis asked, a "no" recorded as a no, fixed rules (not the model) choosing modules, a note under each reply saying who read it, a fallback that says so, a privacy notice before anyone types, keyboard access, and test-mode checkout with honest labels.
- **The walker, every day after** (rehearsed on the simulator; one turn on the real Pi): the model can only offer a change, nothing changes until a person presses Confirm, the page says "Applied" only when the walker reports it, and "Behind the scenes" draws each step of a turn with the server's own times ("Times are measured.").
- **The care loop on two phones** (built during the event and live on Render; tested in a headless browser, not yet on real iPhones). The names are made up: Rose walks with the walker, Maya is her caretaker.
  - Rose's phone is a simple mode, built the Assistive Access way: three huge tiles (My walker, Message Maya, People nearby), no typing, and "Nothing on this phone changes your walker. To change your alerts, ask Sophi on the walker." Maya's message is read aloud by the phone only when Rose taps it, and she answers with one tap ("I'm okay", "Can you call me?", "I'm on my way").
  - Maya's phone shows whether the walker is on, the alerts in force, part health, "Battery: not measured on this walker", and a thread of messages of up to 30 characters each.
- **Consent design in the care loop:**
  - The owner adds each phone from the walker page with a one-time 6-digit code. A caretaker's phone waits until the owner approves it, and Approve works only once this line is ticked: "Rose agreed that Maya can see whether the walker is on, its part health and its alerts, and exchange short messages with her."
  - The caretaker never sees Rose's conversation with Sophi, the walker's own lines, its obstacle readings, her location, or when she used it.
  - Messages are deleted 24 hours after sending, and at once when a phone is removed.
  - "People nearby" is fixed sample data with a "Sample" tag and "Sample people for the demo. Sophi doesn't share anyone's location." No location is read.
  - **Honest limits to say if asked:** the caretaker is approved on the owner's page after asking Rose, not by Rose's own Confirm on the walker; the consent is checked, not stored, so there is no record of who agreed or when; and a caretaker can't suggest an alert change (Maya sends a message, and Rose asks Sophi herself).

**Three things to add to the pitch (the weak criteria):**

1. **Customer understanding.** Talk to one person who knows walkers: someone who uses one, a physical or occupational therapist, or a family caregiver. Ask first whether they agree to be quoted and how they'd like to be named (a first name, a role, or not at all). Show them the website, let them type their own answers if they want to (only on the deterministic engine or a paid model key, never on the free Gemini key), and ask:
   - "Do these questions make sense for someone choosing a walker?"
   - "What would you want it to ask that it doesn't?"
   - "Which of these parts would you never want, and why?"
   - "What would make you trust it, or not?"

   Write down what they said and what you'd change, with their consent, in the table below. Quote only what they agreed to, with no medical details. If nobody can be found, the pitch says "we haven't tested it with walker users yet; that's next", which is what the Q&A already says.

   | Date | Who (as they agreed to be named) | Consent to quote | What they said | What we'd change |
   | --- | --- | --- | --- | --- |
   | Not done yet | | | | |

2. **Measured usefulness.** Say only measured numbers, each with when and how it was measured.
   - Measured on 2026-10-23 (rehearsal, `main` at `daea268`): across 39 Gemini turns of Wren's lines, no fallbacks, 1.8 to 3.6 seconds a turn, median 2.3 seconds.
   - Measured on 2026-10-24 (one run of the committed rehearsal, `main` at `0388a5d`, while this laptop was under heavy load from other builds): 13 Gemini turns, all 3 paths passed, no fallbacks, 2.9 to 7.6 seconds a turn, median 3.7 seconds. The time is measured in-process, so local load inflates it; this run isn't a fair speed figure.
   - Re-measure on the day, with nothing else running, using `REHEARSE_PROVIDER=gemini pnpm --filter @walker/cloud-api rehearse` (see "Rehearse on a model" below). If turns take more than about 5 seconds, follow the script's "The agent is slow" fallback.
   - To measure at the venue: time three people who haven't seen Sophi setting up a walker on the website without help, from the first keypress to "Your walker". Say who they were ("three hackers at the venue, not walker users"). Record each time below; never round up a sample this small into a claim.

     | Date | Person (no names) | Engine | Time to "Your walker" | Turns | Needed help? |
     | --- | --- | --- | --- | --- | --- |
     | Not done yet | | | | | |

   - On the walker: the always-on design measures "Talk released to the answer starting" (target 4 seconds). On the simulator (2026-10-24, [walker-script.md](walker-script.md#rehearsal-results)): Talk released to the reply's text, 1.9 to 4.6 seconds, median 2.7, over 16 spoken turns (on `main` at `37a691c`). Say "on the simulator" when quoting it. On the real Pi, one turn so far: 3.96 seconds from letting go of Talk to the answer arriving (2026-10-24, before the backup model); one turn isn't a range.
   - The backup model's effect on the walker's slowest turns (the slowest went from 8.0 to 5.0 seconds in local tests) is in [the MLH section](#mlh-best-use-of-gemini-api-free-entry), with how it was measured.

3. **Path to production (15 seconds, in the close).** "What's built: continuous integration on every change, a live deploy, row-level security on saved setups, device authentication and versioned settings for the walker, a fallback for every model turn, a backup model when the main one is slow, and a written motion safety contract before any motor moves. What isn't: bench validation of the hardware, testing with walker users, a paid model tier for real people's words, and a regulatory review we haven't started."

**The 2-minute cut (the care loop):**

1. **0:00 to 0:37, setting it up:** the onboarding [60-second cut](script.md#the-60-second-cut) from 0:00 to 0:37: Wren's line, the walker drawing itself, Skip and "Show My Walker", and "You said" in the obstacle sensors' panel.
2. **0:37 to 1:10, the walker every day after:** the bridge line ("This is the walker every day after. It isn't Wren's: this one is Rose's, set up with voice on. Rose is made up too."), then the walker's [beat 4](walker-script.md#beat-4-change-a-setting-100-to-135): a spoken request, Sophi's offer, the Confirm press, "Applied". Point at "Behind the scenes": Gemini, the rule, "Offer written by the server".
3. **1:10 to 1:40, the two phones,** both on cellular. Before judges arrive, link Rose's phone; just before the cut, have Maya's phone enter its code, so it shows "Waiting for the family to approve" (a waiting join lapses after 5 minutes). On the walker page's Phones card, tick the consent line ("Rose agreed that Maya can see…") and press Approve; Maya's phone opens. Maya sends "Dinner at six. I'll get you."; Rose's tile shows "1 new message", she taps it and her phone reads it aloud; she taps "I'm okay", and it appears in Maya's thread. "Rose's phone has three tiles and nothing that changes her walker. Maya got in only after the family ticked what Rose agreed to, and she sees whether the walker is on and how its alerts work, never what Rose says to Sophi."
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

**Status, 2026-10-24:** built on `main` (#39). Max's key is in on Render. A spoken question to the deployed server came back in Cartesia's voice (4.1 s end to end, 2026-10-24), and the same night one spoken turn on the real Pi was answered in Cartesia's voice and heard through the walker's soundbar (3.96 s from letting go of Talk to the answer and its audio arriving). The simulator rehearsal ran before the key, so every reply there was spoken in the walker's own voice (`voiced_by: "walker"`, [walker-script.md](walker-script.md#rehearsal-results)). "In Cartesia's voice" under a reply on the page hasn't been recorded as seen in a run yet. Don't name Cartesia in a demo until a key is in and that day's run shows "In Cartesia's voice" under a reply.

**Why voice is core here:** a walker user's hands are on the handles. Talk is a button on the handle; the answer comes back out loud, and the same words appear on the "Your walker" page and, once it runs on the panel, as captions on the walker's own screen, so voice is never the only way to get them.

### Sophi and Cartesia (the README section for Cartesia's judges)

**What Cartesia does in Sophi:** it is Sophi's speaking voice on the walker. Hold Talk and ask a question; Google's Gemini hears the clip and writes the answer; the server sends only the answer's text to Cartesia's text-to-speech and returns the audio with the answer; the walker plays it. The page notes under each reply which voice spoke it: "In Cartesia's voice" or "In the walker's own voice". Its "Behind the scenes" panel shows the voice step as "Sent in Cartesia's voice" with the time the server measured for it.

**Setup:**

1. Create a Cartesia account and an API key. When creating the account, file Cartesia's training opt-out (see "Max's steps" below).
2. Put the key in the server's environment as `CARTESIA_API_KEY`: on Render, **steady-walker → Environment** (the Blueprint in [`render.yaml`](../../render.yaml) asks for it); for a local server, `apps/web/.env.local`. Never in the repository, a commit or chat. Empty or `none` means no key: the walker then speaks with its own voice. `CARTESIA_VOICE_ID` may name another stock voice.
3. Restart the server, pair a walker (or run the Pi service's simulator against the server: [devices/pi](../../devices/pi/README.md)), hold Talk and ask "What can you help me with?". The page shows "In Cartesia's voice" under the reply, and the server's log line for the turn says `voiced_by=cartesia` with the voice's time in `voice_ms`.

**Cartesia features used** (checked against [Cartesia's API reference](https://docs.cartesia.ai/api-reference/tts/bytes) on 2026-10-24; code in [`speech.ts`](../../services/cloud-api/src/walker/speech.ts)):

- Sonic text-to-speech, model `sonic-3.6`, through `POST https://api.cartesia.ai/tts/bytes` with `Cartesia-Version: 2026-08-14`.
- A stock English voice, "Skylar" (`language: "en"`), one Cartesia recommends for voice agents. No voice is cloned.
- WAV output at 16 kHz, mono, 16-bit PCM: what the walker's player takes. The server checks the header before sending it on.
- Called from the server only, so the key never reaches the walker or the browser.

**How it behaves when something goes wrong:** the voice gets at most 3 seconds inside the server's 8-second budget for a turn (the walker gives up at 10). When the backup model answers after its 4.5-second switch-over, the voice still has its full 3 seconds. No key, an error, a slow answer, audio longer than about a minute, or audio the walker can't play: the answer comes back without speech, and the walker says it in its own voice (Piper or espeak-ng on the Pi). The walker's own fixed lines ("Sophi is on", "Nothing to confirm", "I'm offline right now…", "I need to be paired again") are written on the Pi. Since Cooper's commit `ec8b3d4` (2026-10-24) a paired Pi asks the server to say them in the same Cartesia voice (`POST /devices/{id}/speech`, no model call and no stored turn, a 3-second limit), and uses its own voice when that fails or there's no connection, so it still talks with no internet and offline lines can sound different. That route is in code; its live check is pending. Typed questions from the page are answered on the page and not spoken.

**Known limitations:**

- Heard live through the deployed server on 2026-10-24 (a spoken question answered in Cartesia's voice, 4.1 s end to end; two replies made in 0.9 and 1.3 s), and on the real Pi's soundbar for one turn the same night. The six demo beats haven't run on the real Pi, and "In Cartesia's voice" on the page hasn't been recorded as seen.
- On the simulator, without Cartesia, the reply's text reached the walker 1.9 to 4.6 seconds after Talk was released (median 2.7 seconds over 16 spoken turns; [walker-script.md](walker-script.md#rehearsal-results)). Cartesia's time, at most 3 seconds, comes on top of the server's part of that. The one real Pi turn took 3.96 seconds including Cartesia's time.
- The whole reply is made before it plays (the bytes endpoint, not streaming), so Cartesia's time adds to the wait after Talk is released. Streaming over Cartesia's WebSocket would start sooner; it isn't built.
- Captions on the walker's screen (built 2026-10-24) have run only in the simulator under headless Chromium, not on the Pi or the panel, and with the simulator's fake server, so "You said" and "Answered by Gemini" on the screen have been drawn only from example states so far.
- English and one stock voice only.
- Needs the internet; offline, the walker uses its own voice.
- Data: Cartesia's terms (revised June 14, 2024; read 2026-10-24) let Cartesia use inputs and outputs to train its models unless the account opts out, state no retention period, and offer zero data retention only on enterprise plans. Only Sophi's reply text is sent (it can repeat some of the person's words), never the voice clip. Until those terms allow real people's words, only scripted, made-up lines go through it.

### Notice wording

- **The "Your walker" page** (built, in [`walkerView.ts`](../../apps/web/src/lib/walkerView.ts)) says before anyone types: "Your words go to Google's Gemini, which may keep a copy, and the text of Sophi's spoken replies goes to Cartesia. Please don't type names or health details. Each message is deleted an hour after it's sent, or right away with Forget this walker."
- **A card on the walker** (printed, for the table): "Only the presenter talks to this walker. What's said goes to Google's Gemini, and Sophi's replies are spoken by Cartesia from their text; both may keep a copy. Want to try it? Type on the screen, and leave out names and health details."
- **Said aloud at the Talk beat:** "Sophi's answer is in Cartesia's voice. Only the answer's text goes to Cartesia, never the speaker's voice."

### The 2-minute cut

Demo first, then the why. The beats and their exact lines are in the walker script, [`walker-script.md`](walker-script.md); this cut uses four of them.

1. **0:00 to 0:15, boot:** the walker says "Sophi is on." (in Cartesia's voice once the Pi's request for it is checked live, otherwise in its own voice; check which on the day), and the page shows "Online" with each part's health.
2. **0:15 to 0:40, ask:** Talk: "What can you help me with?" The answer comes back out loud in Cartesia's voice (in the model's own words), and the page shows "You said (as heard by Gemini)", the reply, and "In Cartesia's voice". Say the line about where the text goes. Only if the walker's screen has been rehearsed on the panel that day (so far it has run only in the simulator): point at it as it goes "Listening", "One moment", then the reply as captions.
3. **0:40 to 1:15, change a setting:** Talk: "Stop buzzing me, use short sounds instead." Sophi says "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." (the server writes this line from the change itself). Press Confirm on the walker. It says "Done. Obstacle alerts now use short sounds.", and the page's alerts change to "Version 2", "Short sounds" and then "Applied" (2 to 9 seconds after Confirm in the rehearsal; keep talking meanwhile).
4. **1:15 to 1:35, offline:** unplug the walker's Ethernet cable at the Pi's end (never at the venue's switch; the walker's Wi-Fi backup must be off, see the walker script's setup B, step 3), and plug it back in to return. After about 6 to 10 seconds (on the simulator; unplugging hasn't been timed) the walker says, once, "I'm offline right now. Your short-sound alerts still work.", in its own voice, and a Talk press then gets the same line at once. "Cartesia speaks when it can; the walker never goes silent." On the simulator, cutting the network needs the walker script's setup checklist.
5. **1:35 to 2:00, why and how:** "Your hands are on the handles, so voice is how you ask. Push to talk, never a listening microphone. Gemini hears, Cartesia speaks, the walker's own voice covers offline, and every word is on the page too, for anyone who can't hear it."

**Max's steps:**

- Create the Cartesia account and key, and file Cartesia's training opt-out when creating the account.
- Paste the key into Render's environment as `CARTESIA_API_KEY`.
- Check the plan's terms. A third-party guide says the free plan is for personal, non-commercial use.
- Then run the cut once that day before mentioning Cartesia.

## Anthropic (only with a Claude key)

**What the judges score:** a named community, a real problem ("you have lived it, or you talked to someone who has"), it works ("one thing done well and usable on Monday"), and thoughtful use of Claude ("Claude does something that matters to the solution, and you know where it could go wrong for the people using it").

**The named community (pick after the conversation in the Microsoft section):** for example "people who use a rollator around home and local shops and find small buttons hard to press".

**What Claude does in Sophi:** the onboarding agent was built for Claude first (`services/cloud-api/src/onboarding/anthropic.ts`: Claude Opus 5.5 at low effort, one structured-output call per turn, the server-side refusal fallback on). It reads the person's words as a fixed list of needs, picks the next topic from a fixed list and words the question, and writes a one-line acknowledgement. It never picks a module.

**Where it could go wrong, and what Sophi does about it:** the model could misread a need (each part's panel quotes the words it came from, and every switch stays with the person); it could fail or be slow (a 15-second deadline, then the fixed questions, with a note saying so); it could be steered by what someone types (her words are passed as data, and fixed rules choose modules); and people's words leave the laptop (the notice names who reads them before anyone types).

**Status:** the adapter is built and tested with stub models only. It has never run live, because there is no Claude key on the demo laptop.

**To switch the demo to Claude (Max pastes the key):**
1. Put `ANTHROPIC_API_KEY` and `ONBOARDING_AGENT_PROVIDER=anthropic` in `apps/web/.env.local`.
2. Rehearse: `REHEARSE_PROVIDER=anthropic pnpm --filter @walker/cloud-api rehearse`. It must pass every path on all 3 runs with every reply from the model, as Gemini did.
3. Rebuild and start as in the script's setup checklist. The notice must name "Anthropic's Claude", and each reply must say "Read by Claude". Mention Claude only after that check.
4. Check Anthropic's current commercial terms on retention and training, and update judge Q&A 1 and 2 in the script to match.

**The 2-minute cut:** the Microsoft cut, with the named community in the first sentence and the "where it could go wrong" answer in place of the path-to-production line.

## MLH: Best Use of Gemini API (free entry)

**Where Gemini runs:**
- **Onboarding,** on the demo laptop today: `gemini-3.7-flash` (low thinking) reads her words and words each question.
- **The walker assistant:** one call hears the spoken clip and writes the answer. Two models are asked at the same moment: `gemini-3.7-flash` (low thinking), whose answer is used if it comes within 4.5 seconds, and `gemini-3.6-flash` (minimal thinking), about 2.5 times faster. After 4.5 seconds the first usable answer wins; if 3.7 fails early, 3.6's answer is used at once. Once one is picked, the other request is cancelled. Everything after the model is unchanged: the server words every offer, and only a Confirm press changes the walker, so a wrong answer can't change the walker by itself.
- **Never "clear" or "safe":** a sensor can miss things, so every reply in the model's own words is checked for "clear" or "safe" in any form, even in a denial. A reply that says it gets one retry with a note naming the rule (never the person's words), and a second one gets the fixed line.

**Measured** (#59 and #60, 2026-10-23, real Gemini, the walker live suite run locally without voice; deployed to Render by its auto-deploy of `main`, but not measured on Render or the Pi):

| | 3.7 alone, 120 turns | With 3.6 as backup (5 s switch-over, the prototype), 210 turns |
| --- | --- | --- |
| Median | 3.07 s | 3.09 s |
| 90th percentile | 5.80 s | 5.00 s |
| Slowest | 8.0 s (a timeout) | 5.0 s |
| Fixed fallback lines | 1 | 0 |

- 3.6's answer was used on 26 of the 210 turns, all correct, including one real 3.7 timeout. It named the right alert change on 56 of 56 alert-change turns.
- The built version, at 4.5 seconds: 60 of 60 turns passed over two runs, the slowest 4.51 seconds; 3.6 answered 12 of them, all correct.
- The "clear or safe" check: the demo's lines needed no retries (30 of 30 with the backup). On leading questions ("Is the way ahead clear?", "Is it safe to walk forward?"), with the backup on, 10 of 12 were retried; 11 ended in a clean answer (3.9 to 5.8 seconds) and 1 in the fixed line at the 8-second limit.
- What it costs: twice the Gemini calls on every turn. A word list can't catch every way of saying "clear"; the prompt asks for the rest.

**What to show** (30 seconds, inside any walker cut): the "Behind the scenes" panel on the walker page draws each turn's Gemini step with the time the person actually waited. It says "Gemini" for both models, which is true; the server's log names the one that answered.

Pick the category on Devpost and say where Gemini is used. Keep the free-tier rule: only scripted, made-up lines go to the free key.

## Rehearse on a model

`pnpm --filter @walker/cloud-api rehearse` runs Wren's lines through the real onboarding service in memory on the script's three paths (full, 3-minute, 60-second). Without `REHEARSE_PROVIDER` it runs the fixed questions only, which also run in CI on every change. With `REHEARSE_PROVIDER=gemini` or `anthropic` it also runs the model 3 times (`REHEARSE_RUNS` changes that), reading the key from the environment or from `apps/web/.env.local`, never printing it, and prints each turn, its time, and a summary such as "15 model turns, 0 fallbacks, 1.8 to 3.6 s, median 2.3 s". A path passes only if the topics come in the script's order, the right parts light after every line, the final walker matches, voice isn't suggested, the arms are "worth considering", and no turn fell back.
