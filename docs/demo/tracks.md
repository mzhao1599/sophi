# Sophi for each sponsor track

This page is for the presenter and for whoever writes the Devpost submission. For each sponsor track Sophi enters, it says what the judges score, what Sophi really shows today, a 2-minute cut that opens on that track's moment, and the proof to bring. The [main demo script](script.md) stays the source for Wren's lines, the setup checklist and the honesty lines; this page only reorders and frames them.

**Status, 2026-10-24.** Real today: the onboarding website (conversation, the walker drawing, "Your walker", save, and an order in Stripe's test mode). Built and rehearsed on the walker simulator: the always-on walker assistant (the Pi service, its server with the assistant on Gemini, and the "Your walker" live page); its script is [walker-script.md](walker-script.md). The server runs on Render (<https://steady-walker.onrender.com>), checked end to end on 2026-10-24, including a reply in Cartesia's voice. Not yet run: the real Pi. Not built: the walker hardware integration. Nothing below presents a planned part as working; each cut that needs a planned part says so.

**Which tracks, and why.** The sponsor-track analysis (2026-10-24) ranked four tracks plus one free entry: Microsoft's "Built for the Real World" (and its Customer Impact Award), Visa's "Reimagining Shopping", Cartesia's voice track, Anthropic's track, and MLH's "Best Use of Gemini API". The others don't fit without work off the demo path or against the project's safety and consent rules.

## Before submitting (all tracks)

- **Say when the work started.** Cal Hacks 13.0's FAQ says "all implementation must occur during the hackathon". Max said on 2026-10-24 that Sophi is already cleared under this rule. The submission still says plainly that work began on 2026-10-23 and lists what was built during the event, because the demo never hides anything from judges.
- **Pick each track on Devpost** at submission, plus the MLH Gemini category. Ask at the event how many prizes one project may enter.
- **Outward steps are Max's:** creating sponsor accounts, pasting keys, posting the submission and any public link.

## Microsoft: Built for the Real World

**What the judges score:** customer understanding, measurable usefulness, a path from prototype to production, responsible design, and end-to-end functionality. The challenge asks for "a production-minded AI agent that solves a meaningful problem in finance, productivity, healthcare, or another high-impact domain". The track text doesn't require Microsoft products; ask at the Microsoft booth.

**What Sophi shows today:** the whole [3-minute script](script.md#the-3-minute-script). Its "real-world" points are made by the product itself: no diagnosis asked, a "no" recorded as a no, fixed rules (not the model) choosing modules, a note under each reply saying who read it, a fallback that says so, a privacy notice before anyone types, keyboard access, and test-mode checkout with honest labels.

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

   - On the walker: the always-on design measures "Talk released to the answer starting" (target 4 seconds). On the simulator (2026-10-24, [walker-script.md](walker-script.md#rehearsal-results)): Talk released to the reply's text, 1.9 to 4.6 seconds, median 2.7, over 16 spoken turns (on `main` at `37a691c`). Say "on the simulator" when quoting it; the real Pi isn't measured.

3. **Path to production (15 seconds, in the close).** "What's built: continuous integration on every change, a live deploy, row-level security on saved setups, device authentication and versioned settings for the walker, and a fallback for every model turn. What isn't: bench validation of the hardware, testing with walker users, a paid model tier for real people's words, and a regulatory review we haven't started."

**The 2-minute cut:** the 3-minute script's 0:00 to 1:50 (cold open, the walker drawing itself, the notice, "no" recorded as a no, "Your walker" quoting her words), then the path-to-production line above instead of the order beat. If the walker assistant is running and was rehearsed that day, swap the last 30 seconds for its "Change a setting" beat (a spoken request, Sophi's proposal, the Confirm press, "Applied").

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

**Status, 2026-10-24:** built on `main` (#39). Max's key is in on Render, and a spoken question to the deployed server came back in Cartesia's voice (4.1 s end to end). The simulator rehearsal ran before the key, so every reply there was spoken in the walker's own voice (`voiced_by: "walker"`): in that rehearsal ([walker-script.md](walker-script.md#rehearsal-results)) the page said "In the walker's own voice" under every spoken reply, and "In Cartesia's voice" hasn't been seen on screen yet. Don't name Cartesia in a demo until a key is in and that day's run shows "In Cartesia's voice" under a reply. The walker itself has run only as the Pi service's simulator on a Mac, not yet on the real Pi with its speaker.

**Why voice is core here:** a walker user's hands are on the handles. Talk is a button on the handle; the answer comes back out loud, and the same words appear on the "Your walker" page, so voice is never the only way to get them.

### Sophi and Cartesia (the README section for Cartesia's judges)

**What Cartesia does in Sophi:** it is Sophi's speaking voice on the walker. Hold Talk and ask a question; Google's Gemini hears the clip and writes the answer; the server sends only the answer's text to Cartesia's text-to-speech and returns the audio with the answer; the walker plays it. The page notes under each reply which voice spoke it: "In Cartesia's voice" or "In the walker's own voice".

**Setup:**

1. Create a Cartesia account and an API key. When creating the account, file Cartesia's training opt-out (see "Max's steps" below).
2. Put the key in the server's environment as `CARTESIA_API_KEY`: on Render, **steady-walker → Environment** (the Blueprint in [`render.yaml`](../../render.yaml) asks for it); for a local server, `apps/web/.env.local`. Never in the repository, a commit or chat. Empty or `none` means no key: the walker then speaks with its own voice. `CARTESIA_VOICE_ID` may name another stock voice.
3. Restart the server, pair a walker (or run the Pi service's simulator against the server: [devices/pi](../../devices/pi/README.md)), hold Talk and ask "What can you help me with?". The page shows "In Cartesia's voice" under the reply, and the server's log line for the turn says `voiced_by=cartesia` with the voice's time in `voice_ms`.

**Cartesia features used** (checked against [Cartesia's API reference](https://docs.cartesia.ai/api-reference/tts/bytes) on 2026-10-24; code in [`speech.ts`](../../services/cloud-api/src/walker/speech.ts)):

- Sonic text-to-speech, model `sonic-3.6`, through `POST https://api.cartesia.ai/tts/bytes` with `Cartesia-Version: 2026-08-14`.
- A stock English voice, "Skylar" (`language: "en"`), one Cartesia recommends for voice agents. No voice is cloned.
- WAV output at 16 kHz, mono, 16-bit PCM: what the walker's player takes. The server checks the header before sending it on.
- Called from the server only, so the key never reaches the walker or the browser.

**How it behaves when something goes wrong:** the voice gets at most 3 seconds inside the server's 8-second budget for a turn (the walker gives up at 10). No key, an error, a slow answer, audio longer than about a minute, or audio the walker can't play: the answer comes back without speech, and the walker says it in its own voice (Piper or espeak-ng on the Pi). The walker's fixed lines ("Sophi is on", "I'm offline right now…", "I need to be paired again") always use its own voice, so it still talks with no internet. Typed questions from the page are answered on the page and not spoken.

**Known limitations:**

- Heard live through the deployed server on 2026-10-24 (a spoken question answered in Cartesia's voice, 4.1 s end to end; two replies made in 0.9 and 1.3 s), but not yet on the real Pi's speaker, and not yet seen as "In Cartesia's voice" on the page.
- On the simulator, without Cartesia, the reply's text reached the walker 1.9 to 4.6 seconds after Talk was released (median 2.7 seconds over 16 spoken turns; [walker-script.md](walker-script.md#rehearsal-results)). Cartesia's time, at most 3 seconds, comes on top of the server's part of that.
- The whole reply is made before it plays (the bytes endpoint, not streaming), so Cartesia's time adds to the wait after Talk is released. Streaming over Cartesia's WebSocket would start sooner; it isn't built.
- English and one stock voice only.
- Needs the internet; offline, the walker uses its own voice.
- Not yet run on the real Pi with its USB speaker.
- Data: Cartesia's terms (revised June 14, 2024; read 2026-10-24) let Cartesia use inputs and outputs to train its models unless the account opts out, state no retention period, and offer zero data retention only on enterprise plans. Only Sophi's reply text is sent (it can repeat some of the person's words), never the voice clip. Until those terms allow real people's words, only scripted, made-up lines go through it.

### Notice wording

- **The "Your walker" page** (built, in [`walkerView.ts`](../../apps/web/src/lib/walkerView.ts)) says before anyone types: "Your words go to Google's Gemini, which may keep a copy, and the text of Sophi's spoken replies goes to Cartesia. Please don't type names or health details. Each message is deleted an hour after it's sent, or right away with Forget this walker."
- **A card on the walker** (printed, for the table): "Only the presenter talks to this walker. What's said goes to Google's Gemini, and Sophi's replies are spoken by Cartesia from their text; both may keep a copy. Want to try it? Type on the screen, and leave out names and health details."
- **Said aloud at the Talk beat:** "Sophi's answer is in Cartesia's voice. Only the answer's text goes to Cartesia, never the speaker's voice."

### The 2-minute cut

Demo first, then the why. The beats and their exact lines are in the walker script, [`walker-script.md`](walker-script.md); this cut uses four of them.

1. **0:00 to 0:15, boot:** the walker says "Sophi is on." in its own voice, and the page shows "Online" with each part's health.
2. **0:15 to 0:40, ask:** Talk: "What can you help me with?" The answer comes back out loud in Cartesia's voice (in the model's own words), and the page shows "You said (as heard by Gemini)", the reply, and "In Cartesia's voice". Say the line about where the text goes.
3. **0:40 to 1:15, change a setting:** Talk: "Stop buzzing me, use short sounds instead." Sophi says "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." (the server writes this line from the change itself). Press Confirm on the walker. It says "Done. Obstacle alerts now use short sounds.", and the page's alerts change to "Version 2", "Short sounds" and then "Applied" (2 to 9 seconds after Confirm in the rehearsal; keep talking meanwhile).
4. **1:15 to 1:35, offline:** turn off the walker's hotspot. After about 6 to 10 seconds the walker says, once, "I'm offline right now. Your short-sound alerts still work.", in its own voice, and a Talk press then gets the same line at once. "Cartesia speaks when it can; the walker never goes silent." On the simulator, cutting the network needs the walker script's setup checklist.
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

Gemini (`gemini-3.7-flash`, low thinking) words the onboarding questions on the demo laptop today, and the walker assistant's design uses it to hear and answer speech. Pick the category on Devpost and say where Gemini is used. Keep the free-tier rule: only scripted, made-up lines go to the free key.

## Rehearse on a model

`pnpm --filter @walker/cloud-api rehearse` runs Wren's lines through the real onboarding service in memory on the script's three paths (full, 3-minute, 60-second). Without `REHEARSE_PROVIDER` it runs the fixed questions only, which also run in CI on every change. With `REHEARSE_PROVIDER=gemini` or `anthropic` it also runs the model 3 times (`REHEARSE_RUNS` changes that), reading the key from the environment or from `apps/web/.env.local`, never printing it, and prints each turn, its time, and a summary such as "15 model turns, 0 fallbacks, 1.8 to 3.6 s, median 2.3 s". A path passes only if the topics come in the script's order, the right parts light after every line, the final walker matches, voice isn't suggested, the arms are "worth considering", and no turn fell back.
