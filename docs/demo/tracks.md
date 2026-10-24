# Steady for each sponsor track

This page is for the presenter and for whoever writes the Devpost submission. For each sponsor track Steady enters, it says what the judges score, what Steady really shows today, a 2-minute cut that opens on that track's moment, and the proof to bring. The [main demo script](script.md) stays the source for Wren's lines, the setup checklist and the honesty lines; this page only reorders and frames them.

**Status, 2026-10-24.** Real today: the onboarding website (conversation, the walker drawing, "Your walker", save, and an order in Stripe's test mode). Being built: the always-on walker assistant (the Pi service, the server on Render, the "Your walker" live page, and Cartesia's voice for spoken replies). Not built: the walker hardware integration. Nothing below presents a planned part as working; each cut that needs a planned part says so.

**Which tracks, and why.** The sponsor-track analysis (2026-10-24) ranked four tracks plus one free entry: Microsoft's "Built for the Real World" (and its Customer Impact Award), Visa's "Reimagining Shopping", Cartesia's voice track, Anthropic's track, and MLH's "Best Use of Gemini API". The others don't fit without work off the demo path or against the project's safety and consent rules.

## Before submitting (all tracks)

- **Say when the work started.** Cal Hacks 13.0's FAQ says "all implementation must occur during the hackathon". Max said on 2026-10-24 that Steady is already cleared under this rule. The submission still says plainly that work began on 2026-10-23 and lists what was built during the event, because the demo never hides anything from judges.
- **Pick each track on Devpost** at submission, plus the MLH Gemini category. Ask at the event how many prizes one project may enter.
- **Outward steps are Max's:** creating sponsor accounts, pasting keys, posting the submission and any public link.

## Microsoft: Built for the Real World

**What the judges score:** customer understanding, measurable usefulness, a path from prototype to production, responsible design, and end-to-end functionality. The challenge asks for "a production-minded AI agent that solves a meaningful problem in finance, productivity, healthcare, or another high-impact domain". The track text doesn't require Microsoft products; ask at the Microsoft booth.

**What Steady shows today:** the whole [3-minute script](script.md#the-3-minute-script). Its "real-world" points are made by the product itself: no diagnosis asked, a "no" recorded as a no, fixed rules (not the model) choosing modules, a note under each reply saying who read it, a fallback that says so, a privacy notice before anyone types, keyboard access, and test-mode checkout with honest labels.

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
   - To measure at the venue: time three people who haven't seen Steady setting up a walker on the website without help, from the first keypress to "Your walker". Say who they were ("three hackers at the venue, not walker users"). Record each time below; never round up a sample this small into a claim.

     | Date | Person (no names) | Engine | Time to "Your walker" | Turns | Needed help? |
     | --- | --- | --- | --- | --- | --- |
     | Not done yet | | | | | |

   - On the walker, once it runs: the always-on design measures "Talk released to the answer starting" (target 4 seconds, not yet measured). Quote it only after it's measured on the real Pi.

3. **Path to production (15 seconds, in the close).** "What's built: continuous integration on every change, a live deploy, row-level security on saved setups, device authentication and versioned settings for the walker, and a fallback for every model turn. What isn't: bench validation of the hardware, testing with walker users, a paid model tier for real people's words, and a regulatory review we haven't started."

**The 2-minute cut:** the 3-minute script's 0:00 to 1:50 (cold open, the walker drawing itself, the notice, "no" recorded as a no, "Your walker" quoting her words), then the path-to-production line above instead of the order beat. If the walker assistant is running and was rehearsed that day, swap the last 30 seconds for its "Change a setting" beat (a spoken request, Steady's proposal, the Confirm press, "Applied").

## Visa: Reimagining Shopping

**What the judges score:** innovation (25%), user experience (25%), technical execution (20%), commerce impact (15%), trust and responsibility (15%). The track text doesn't require a Visa API; ask at the Visa booth. If one is required, this track probably drops off the list.

**The line:** "Shopping for a mobility aid usually means reading parts lists. Here she says what's hard, the cart builds itself, every item can say why it's there in her own words, and the price counts only what she chose."

**What Steady shows today:**
- The cart is built from her words, not from browsing: the walker drawing lights up suggested parts as she answers.
- Each part says why it's suggested, quoting her ("You said: …"), and a part she declined stays out, marked "You Said No".
- The most experimental parts (robot arms, arm lift) are never added by default; she switches them on herself.
- The walker sheet shows a running total beside the module count, for example "5 modules · $1,675 at demo prices, not a real quote", from the same table Checkout charges. Each switch's announcement reads the new total for screen-reader users.
- Stripe's checkout page lists each module with the catalog's one-sentence summary of what it does (never her own words, because Checkout data goes to Stripe) and "demo price, not a real quote".
- Trust: Stripe test mode only (the server refuses live keys), placeholder prices labelled everywhere, no card form on our site, ids-only metadata, and a success page that says "Demo order: no money moved".

**Honest limits to say if asked:** nothing can really be sold (Steady is a prototype, not a certified mobility aid), prices are placeholders, and we have no sales or conversion data.

**The 2-minute cut:** Wren's L1 (the cart starts building), L4 (her "no" stays out of the cart), "Show My Walker", one part's panel ("You said …"), switch on the arms and lift and point at the total changing, Save, Order (Demo), Stripe's page with the module summaries, pay with the test card, and end on "Demo order: no money moved".

## Cartesia: Best Use of Cartesia (only once built)

**What the judges score (25% each):** problem and originality; use of Cartesia (core to the experience; clear, responsive and natural voice); execution; impact and responsibility (accessibility, privacy, responsible use). Submission: a working demo, a 2-minute demo-first presentation, a short README (setup, Cartesia features used, known limitations), source access, and no keys in the repo.

**Status:** planned, not on `main`. The walker contract (merged in #26) already carries a spoken reply in Cartesia's voice (`speech`, with `voiced_by: "cartesia"`), and the Pi service plays it. The server's call to Cartesia's text-to-speech is being built in the walker assistant's cloud piece. Until that lands and has been heard working, don't mention Cartesia.

**Why voice is core here:** a walker user's hands are on the handles. Talk is a button press on the handle, and the answer comes back out loud.

**What only Cartesia does in Steady:** it speaks the assistant's replies. Only Steady's own reply text goes to Cartesia, never the person's voice (Gemini hears that). Fixed lines (boot, offline, "pair me again") stay on the walker's local voice, so the walker still speaks with no internet, and if Cartesia fails or is slow the walker speaks the reply itself. A stock voice is used; no one's voice is cloned.

**The 2-minute cut (walker beats from the always-on design):** boot ("Steady is on"), hold Talk and ask "What can you help me with?" (the answer in Cartesia's voice, with "Spoken in Cartesia's voice" on the page), "Stop buzzing me, use short sounds instead" then Confirm, then turn off the hotspot: the walker still answers locally, in its own voice. Then 30 seconds on the problem and how it's built.

**Max's steps:** a Cartesia account and API key, pasted into Render's environment as `CARTESIA_API_KEY`; check Cartesia's terms for the plan used.

## Anthropic (only with a Claude key)

**What the judges score:** a named community, a real problem ("you have lived it, or you talked to someone who has"), it works ("one thing done well and usable on Monday"), and thoughtful use of Claude ("Claude does something that matters to the solution, and you know where it could go wrong for the people using it").

**The named community (pick after the conversation in the Microsoft section):** for example "people who use a rollator around home and local shops and find small buttons hard to press".

**What Claude does in Steady:** the onboarding agent was built for Claude first (`services/cloud-api/src/onboarding/anthropic.ts`: Claude Opus 5.5 at low effort, one structured-output call per turn, the server-side refusal fallback on). It reads the person's words as a fixed list of needs, picks the next topic from a fixed list and words the question, and writes a one-line acknowledgement. It never picks a module.

**Where it could go wrong, and what Steady does about it:** the model could misread a need (each part's panel quotes the words it came from, and every switch stays with the person); it could fail or be slow (a 15-second deadline, then the fixed questions, with a note saying so); it could be steered by what someone types (her words are passed as data, and fixed rules choose modules); and people's words leave the laptop (the notice names who reads them before anyone types).

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
