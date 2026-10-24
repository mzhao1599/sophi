# Steady: live demo script

**Steady. A smart walker you set up by talking to it.**

This is the script for showing the website to judges at Cal Hacks: a 3-minute main script, a 60-second cut, the persona's exact lines, what each line should do with both onboarding engines, the honesty lines, judge Q&A, the setup checklist, and the rehearsal results.

**What is real today:** the website. A person types what they need, the onboarding assistant asks short questions, the walker drawing lights up suggested modules, and the person saves the walker and orders it through Stripe's test mode. **What is planned:** the walker hardware (frame, hand controls, obstacle sensors, voice module, robot arms, arm lift) and location sharing. Nothing in this script presents a planned part as working.

**Labels marked † are UI labels.** Another session is redesigning the page, so re-check every † label after the redesign lands, and fix this script to match. The name Steady† isn't on the page yet: main still says "Assistive Walker", and the redesign renames it.

## The story

- **The arc:** one sentence in, a walker out. Wren says what is hard in her own words, and Steady draws the walker that helps her. She says no to one part and it stays off, she sees why each suggested part is there, and she orders it.
- **The first ten seconds:** the page is already open, and Wren's first sentence is already typed in the box. The presenter reads it aloud and presses Enter. There is no intro slide and no speech before the product moves.
- **The moment to retell:** "She typed one sentence, the walker drew itself, and every suggested part could say why it was there, in her own words." Two beats carry it: the parts drawing in after the first line (0:10), and the panel that quotes her words back (1:45).
- **When the presenter stops talking:** three planned silences, each about 3 seconds. After the first Enter, let the walker draw. When the walker view, headed "Your walker"†, moves to centre stage, let it land. On the success page, stop and let the judges read it.
- **Who it's aimed at:** Microsoft's "Built for the Real World" judges first. The real-world points are made by the demo itself: no diagnosis asked, the person's "no" is respected, privacy is named on screen, it keeps working when the model doesn't answer, it works without a mouse, and it is honest about what is a prototype.

## The persona: Wren

Wren is a **made-up person**. She has a first name only, no surname, no age and no medical details. She uses a walker around her apartment and to the corner shop. She keeps bumping into things, small buttons are hard for her, and she'd like help picking up things she drops. She would rather not talk to a machine.

**Her exact lines.** Type them as written. Each line is keyed by the question's topic, so if the assistant ever asks the topics in a different order, read the question and type the line for that topic.

| # | Topic (the question†, as the bank words it) | Wren types | Words that must survive a typo |
| --- | --- | --- | --- |
| L1 | tasks ("What would you like help with?") | `I keep bumping into things, small buttons are hard, and I'd like help picking things up.` | "bumping into", "buttons", "picking things up" |
| L2 | places ("Where will you use the walker?") | `Around my apartment, and at the corner shop.` | "apartment", "shop" |
| L3 | feedback ("What's easiest for you to notice?") | `A buzz in the handles works best.` | "buzz" |
| L4 | start_request ("How would you like to ask for help?") | `A button on my left handle. I'd rather not talk to it.` | "left handle", "rather not talk" |
| L5 | reach_detail ("What would you like to reach?") | `Mostly things I drop on the floor.` | "drop", "floor" |
| L6 | location ("Share where the walker is?") | `Yes, so my family can see where the walker is.` | "where the walker is" |
| L7 | anything_else ("Anything else we should know?") | `No, that's everything.` | none |

The 3-minute script uses L1 to L5, then "Skip to my walker"†. The 60-second cut uses L1 only. L6 and L7 are for a longer demo or for a judge who wants to see the whole conversation.

### What each line does, with both engines

"Lit" means the module's status is `recommended` (solid on the drawing) or `consider` (dashed blue: labelled "Worth considering"† during the chat and "Suggested, off"† on the walker view). The walker frame is always included and isn't counted. Voice stays off and location sharing shows "Not available yet"† throughout.

| Line | Deterministic engine: next topic, lit after the line | Gemini agent (3 of 3 runs, before the redesign prompt): next topic, what it read, time |
| --- | --- | --- |
| L1 | places. Lit: hand controls, obstacle sensors (solid); robot arms (dashed) | places, all runs. Read: obstacles, easy controls, picking up. Same lit set. 2.1 to 2.7 s |
| L2 | feedback. No change | feedback, all runs. Read: home, shops. 2.0 to 2.7 s |
| L3 | start_request. No change | start_request, all runs. Read: vibration. 2.2 to 2.8 s |
| L4 | reach_detail. No change; voice stays off, now because she declined it | reach_detail, all runs. Read: left button; declined: asking out loud. 2.3 to 3.6 s |
| L5 | location. Adds the arm lift (dashed) | location, all runs. Read: picking up, reaching low. Same lit set. 2.0 to 2.7 s |
| L6 | anything_else. No change | anything_else, all runs. Read: location sharing. 2.1 to 2.5 s |
| L7 | review (the "Your walker"† view). No change | review, all runs. Read: nothing. 1.8 to 2.4 s |

**The intended walker** after L5 (and after L7): hand controls and obstacle sensors on; robot arms and arm lift worth considering; voice off; location sharing not available yet. After L1 alone (the 60-second cut): hand controls and obstacle sensors on, robot arms worth considering.

**How to tell which engine answered.** Not from the acknowledgement: since PR #20 the fixed questions' acknowledgements vary too ("Got it, …", "Good to know: …"), so wording is no longer a tell. The tell is the terminal running the site: it prints `[onboarding-agent] outcome=agent …` for each model turn, or `outcome=fallback` with a reason when the fixed rules answered instead. A turn falls back when the model errors, runs past the 15-second deadline, or gives two unusable replies. If request 2 below lands, a quiet "read by Gemini"† note will appear under each reply. Carry on after a fallback: the rehearsal shows the same lines light the same parts either way. Never present a fallback turn as the model's.

## The 3-minute script

Each beat gives the presenter's line in quotes, then what happens on screen as numbered steps.

Before you start: the page is open at localhost, fresh (no answers), and L1 is already typed in the box, not sent. Pre-typing only enters the person's words early; the assistant still runs live when you press Enter.

**0:00 to 0:10. Cold open**

> "This is Wren. She's made up. She says: 'I keep bumping into things, small buttons are hard, and I'd like help picking things up.'"

1. Read L1 aloud from the box as part of the line.
2. Press Enter.

**0:10 to 0:24. The walker draws itself**

> "She didn't name a condition or fill in a form. She said what's hard, and the walker drew the parts that help."

1. Thinking dots† show for about 2 to 3 seconds, then the reply fades in†.
2. On the drawing, hand controls and obstacle sensors draw in solid; the robot arms draw in dashed.
3. Say nothing for about 3 seconds while it draws, then say the line.

**0:24 to 0:38. Name it, and say where her words go**

> "This is Steady: a smart walker you set up by talking to it. The line under the box tells her three things: her answers are deleted after an hour, Google's Gemini reads them to choose each question, and Google may keep a copy."

1. Point at the name in the header, Steady†, then at the line under the text box†.

**0:38 to 0:50. Where she'll use it (L2)**

> "It asks one short question at a time. She can type, or tap an answer if typing is hard."

1. Type L2 while speaking: `Around my apartment, and at the corner shop.` Press Enter.

**0:50 to 1:01. How she'd like to be told (L3)**

> "She'd rather feel a buzz in the handles. The hand controls are a planned part, and the choice is hers."

1. Type L3: `A buzz in the handles works best.` Press Enter.

**1:01 to 1:19. Saying no (L4)**

> "And when she says no, it's recorded as a no. Voice stays off."

1. Type L4: `A button on my left handle. I'd rather not talk to it.` Press Enter.
2. Point at voice on the drawing: it stays off.
3. Don't open Voice's panel on stage until request 1 below (the "you said no" state) lands; today it wrongly says nothing she said points to voice.

**1:19 to 1:37. Only what's relevant (L5)**

> "It only asked about reaching because she mentioned picking things up. The arms and the lift are dashed: they're the most experimental parts we plan to build, so the rules never switch them on by themselves. She decides."

1. Type L5: `Mostly things I drop on the floor.` Press Enter.
2. The arm lift draws in dashed, next to the arms.

**1:37 to 1:41. Stop whenever she likes**

> "She can stop at any point."

1. Press "Skip to my walker"†.

**1:41 to 2:00. "Your walker"† (the moment to retell)**

> "Every suggested part can tell her why it's there, in her own words. Fixed rules make the suggestion, and you can read them. The model never picks a part. It reads her words, picks the next question from a fixed list and words it, and writes a one-line reply."

1. The chat folds away and the walker moves to centre stage†. Pause about 3 seconds before speaking.
2. Click the "Obstacle sensors"† label on the drawing. In Chrome, click the label, not the drawn sensors, so Escape closes the panel later. The popover† shows what it does, "Why it was suggested"†, her own words ("Based on:"†) and an on/off switch.

**2:00 to 2:10. No mouse needed (accessibility, 10 seconds)**

> "No mouse needed. Every part is a real button, with a list of the same switches beside it. The chat is built to be read by screen readers, and nothing needs voice."

1. Press Escape to close the popover. Press Tab to move to the next part, Enter to open it, Escape to close it.
2. The keyboard pass was last done on 2026-10-23, before the redesign. Re-run it on the redesigned page before using this beat.

**2:10 to 2:42. Order it (demo)**

> "This is Stripe's test mode. Prices are placeholders, no money moves, and nothing ships."

1. Click "Save my walker"†. "Saved."† appears.
2. Click "Order (demo)"†. Stripe's test checkout opens. Say the line while typing the card.
3. Type the test card `4242 4242 4242 4242`, expiry `12/34`, CVC `123`, the name `Wren Demo`, ZIP `94720`, email `demo@example.com`. Ignore any Apple Pay or Google Pay button. Pay.
4. The success page† ("Demo order complete"†) appears. Stop talking for about 3 seconds.

**2:42 to 3:00. Close**

> "Steady is a prototype, not a certified mobility aid. The walker hardware is planned, and the model will never control a motor. What you've seen is real: she said what's hard, and the walker drew itself around her. Try it on your phone at assistive-walker.vercel.app."

1. Leave the success page on screen.

## The 60-second cut

Same setup: a fresh page with L1 already typed in the box.

**0:00 to 0:10**

> "This is Steady. Wren is made up. She says: 'I keep bumping into things, small buttons are hard, and I'd like help picking things up.'"

1. Read L1 aloud as part of the line. Press Enter.

**0:10 to 0:22**

> "No diagnosis, no form. She said what's hard, and the walker drew the parts that help."

1. Thinking dots†, then the reply fades in†. Hand controls and obstacle sensors draw in solid, robot arms dashed.
2. Pause about 2 seconds, then say the line.

**0:22 to 0:25**

> "She can stop whenever she likes."

1. Press "Skip to my walker"†.

**0:25 to 0:37**

> "Every suggested part says why it's there, in her words. Fixed rules pick the parts, not the model."

1. Click the "Obstacle sensors"† label (in Chrome, the label, not the drawn sensors). The popover† quotes her words.

**0:37 to 0:48**

> "Order runs in Stripe's test mode with placeholder prices. No money moves."

1. Click "Save my walker"†, then "Order (demo)"†. Show Stripe's test checkout page; don't pay.

**0:48 to 1:00**

> "It's a prototype, not a certified mobility aid, and the model never controls a motor. Steady: a smart walker you set up by talking to it. Try it at assistive-walker.vercel.app."

1. Leave the checkout page on screen.

## Optional beats

Use these only when they are true on the day.

- **The unplug beat (Built for the Real World).** Only if rehearsed on the venue network that day, and only if the projector is on a cable, not AirPlay. Before L4, turn Wi-Fi off and say "Hackathon Wi-Fi. Let's lose it." Type L4 and L5. The replies come from the fixed rules (the terminal shows `outcome=fallback`), so say: "Those answers came from the fixed rules, not the model, and it's the same walker." Turn Wi-Fi back on before "Save my walker"†, because Stripe needs the internet. Not verified: how fast the model call fails with Wi-Fi off. If it hangs, the turn waits up to the 15-second deadline before falling back.
- **Hardware, only if the walker is built.** Point at the physical walker and name only the parts that are on it and have been tested by the team that day. Say "planned" for everything else. Don't demo a part that hasn't been tested that day.
- **Location sharing (Meta's "Bringing People Closer Together"), only if built.** Today the catalog marks it "Not available yet"† and the question says it isn't built. If you type L6, say: "She'd like her family to see where the walker is. It isn't built yet; Steady notes her answer."
- **Voice (Cartesia), only if built.** The voice module doesn't exist. Don't mention Cartesia unless it does.
- **Claude (Anthropic's track), only if Claude is on.** Mention Claude only if the setup checklist's engine check shows "Anthropic's Claude". These lines were rehearsed with the deterministic engine and Gemini, not Claude.

## Honesty lines

Say these when they come up, in these words or close to them. AGENTS.md is the source.

- "The model never controls motors. It reads her words, picks the next topic from a fixed list and words the question, and writes a one-line acknowledgement; that's all."
- "Modules are suggested by fixed rules that anyone can read, and each suggestion points back to the person's own words."
- "Steady is a prototype, not a certified mobility aid, and it doesn't replace a caregiver or a clinician's advice."
- "Prices are placeholders, not quotes. Checkout is Stripe's test mode, and no money moves."
- "We haven't measured the hardware. Every cost, weight and power figure in our catalog says not measured."
- "The walker hardware is planned. The parts are ordered; nothing is assembled or tested yet."
- No outside statistics. The only numbers here are our own rehearsal timings, and we say they're ours. Otherwise speak qualitatively ("people who use walkers need very different help").

## Judge Q&A

**1. What happens to what I type?** Answers are deleted an hour after the last change, or right away with "Start over"†. With the agent on, each answer is also sent to Google's Gemini API, and the line under the text box names Google and says Google may keep a copy, before anyone types. Once sent, deleting here can't recall it from Google. That's why the demo uses a made-up persona and the notice asks people to leave out names and medical details.

**2. Does Google use it?** [Fill in from the setup checklist.] If the key's project is on Google's paid tier: Google doesn't use it to improve its products, and keeps it for a limited time to check for abuse. If it's on the free tier: Google can use it to improve its products, people may review it, and the terms say not to send sensitive or personal information. That's why the laptop only gets Wren's made-up lines. On the phone link tonight, no model runs, so nothing typed there goes to Google.

**3. Why don't you let the model choose the modules?** Because a suggestion about a mobility aid should be explainable and the same every time. The model only reads the person's words as a fixed list of needs, picks the next topic from a fixed list and words the question, and writes a one-line acknowledgement. It never sees the module catalog. Fixed rules turn needs into suggestions, each with a reason that quotes the person's words, and the most experimental part (the robot arms) is never switched on by default. If the model fails, the same rules still run.

**4. What if the internet or the model goes down?** Each turn has a 15-second deadline. If the model errors or runs past it, that turn is answered by the fixed question bank and keyword matcher, and the next turn tries the model again. That fallback needs no internet. Stripe's test checkout does need the internet. On the planned walker, the design keeps controls, the stop and obstacle cues on the device so they don't depend on the internet; that's a design, not built.

**5. What will it cost?** We don't have a price. Every cost in our catalog is marked not measured, and checkout uses placeholder prices. The modular design is meant to let a person pay only for the parts that help them. We haven't measured what a setup conversation costs to run on the model either.

**6. Is it safe?** It's a prototype, not a certified mobility aid. The model is never given control of a motor. In the planned walker, any motion needs the person's own start signal, and a physical stop always wins. None of that hardware is built yet, so we make no safety claim today.

**7. Which model is it, and how fast?** Google's Gemini 3.7 Flash with low thinking. These are our own timings of the model's time per turn, measured in-process before the redesign; the page adds a little on top. In our first rehearsal on 2026-10-23, a turn took 1.8 to 3.6 seconds, about 2.4 seconds on average, with no fallbacks over 39 turns. On the new wording (PR #20, before merge), the lead's rerun gave 39 model turns, no fallbacks, a median of 2.3 seconds and a maximum of 6.1 seconds. The provider sits behind one adapter, so it can also run on Anthropic's Claude.

**8. Have real walker users tried it?** Not yet. That's the next step: watch someone who hasn't seen it set up a walker without help, and note where they hesitate. The persona's lines were rehearsed against both engines, not tested with people.

**9. Does it work with a screen reader?** We built it with screen readers in mind, but haven't tested it with one yet. The chat is a live log. On the walker view, every part on the drawing is a real button†, and a list of the same switches sits beside it. Every step works by keyboard, by tapping, or by typing. We checked the whole flow by keyboard alone on 2026-10-23, before the redesign. A VoiceOver or NVDA pass is still to do.

**10. What's next?** Build and bench-test the walker (frame, stop switch, hand controls, obstacle sensors) and measure it; user testing with people who use walkers; a full screen-reader check; and connecting a saved setup to a real walker.

## Setup checklist (before judges arrive)

**Engines tonight.** The presenter's laptop runs the agent (Gemini) locally. The public site at assistive-walker.vercel.app stays on the built-in questions, so judges' phones get the deterministic engine. Both produce the same walker from Wren's lines.

These commands come from the READMEs and `package.json`. This rehearsal didn't start a web server (the laptop was low on disk), so run them once well before the event.

1. **Code and dependencies.** In the main checkout, on the commit you'll demo (after the redesign lands):

   ```bash
   cd /Users/max/Desktop/calhacks26
   ```

   ```bash
   pnpm install
   ```

2. **Settings.** `apps/web/.env.local` (git-ignored) needs `ONBOARDING_ENGINE=agent`, `ONBOARDING_AGENT_PROVIDER=gemini`, `GEMINI_API_KEY` and a Stripe test key in `STRIPE_SECRET_KEY` (`sk_test_…`). Check the names without showing any value, and never open the file on a mirrored screen:

   ```bash
   sed 's/=.*//' apps/web/.env.local
   ```

   `ONBOARDING_AGENT_MODEL` must be empty or absent, so the rehearsed default model runs. This must print `0` (grep then exits with status 1, which is expected here):

   ```bash
   grep -c '^ONBOARDING_AGENT_MODEL=.' apps/web/.env.local
   ```

3. **Port 3000 must be free.** On this laptop another project's dev server may be on port 3000. Check, and stop it if it's there:

   ```bash
   lsof -iTCP:3000 -sTCP:LISTEN
   ```

4. **Start the site, agent on, sessions in memory.** Blanking the three Supabase variables keeps sessions in server memory, so the local Supabase stack isn't needed; values on the command line win over `.env.local`.

   ```bash
   NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= SUPABASE_SECRET_KEY= pnpm dev
   ```

   Open <http://localhost:3000>. If port 3000 can't be freed, use another port, and open that one instead:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= SUPABASE_SECRET_KEY= pnpm --filter @walker/web exec next dev --port 3005
   ```

5. **Engine check.** The header says Steady†. The line under the text box† must include "Google's Gemini reads them to choose each question, and Google may keep a copy"†. After the first answer, the terminal prints `[onboarding-agent] outcome=agent …`; keep that terminal where the presenter can glance at it. If the line doesn't name Google, the deterministic engine is running: fix `.env.local` and restart. Only if it names "Anthropic's Claude" may you mention Claude.
6. **Free-tier check.** Ask the key's owner whether its Google Cloud project has billing on, and write the answer into Q&A 2.
7. **Pre-warm every page.** In development mode, each page compiles the first time it's opened, which can take seconds. Run the whole 3-minute script once, end to end, including the test payment and the success page; open <http://localhost:3000/checkout/cancelled> once; then reset (step 10).
8. **Browser.** Use a separate browser profile with no saved data, so Stripe's email field can't autofill a real address. Close every other tab: email, chat, Messages, password managers, other localhost tabs (another project may use ports 3000 to 3003; after step 3, the only localhost tab should be this demo), any editor showing `.env.local`, and the vercel.app tab. Turn on Do Not Disturb.
9. **Projector zoom.** Zoom with Cmd+= to 110% or 125%. The page stacks into one column below 1000 pixels of page width, which hides the side-by-side walker, so if the walker drops below the chat, zoom out one step (Cmd+-). If mirroring sets the laptop to 1024 by 768, stay at 100%.
10. **Reset between judges.** Press "Start over"† (it may become "Delete my answers"†): it deletes the answers now and starts fresh. After the success page, press "Back to your walker"†, then "Start over"†. Check the chat is empty and the walker is a bare frame, then type L1 into the box without sending it.
11. **Stripe test card,** on a sticky note: `4242 4242 4242 4242`, `12/34`, `123`, `Wren Demo`, `94720`, `demo@example.com`. It's Stripe's public test card, not a secret.
12. **Phone link for judges:** <https://assistive-walker.vercel.app>. The laptop can't open it (see Umbrella below), so check it on a phone on mobile data before judges arrive. It runs the built-in questions tonight: check that its notice doesn't mention Google. It keeps sessions in one server's memory, so a session can occasionally be lost: reload and start again.
13. **Fallbacks.**
    - **No Wi-Fi:** the deterministic engine needs no internet. Restart with it so turns don't wait for the model's deadline: put `ONBOARDING_ENGINE=deterministic` at the front of the step 4 command. Stripe needs the internet, so without it stop at "Saved."† and show the order on a phone instead. A phone hotspot can bring back the internet.
    - **The agent is slow:** each turn falls back to the fixed rules after 15 seconds on its own. If turns take more than about 5 seconds, restart with `ONBOARDING_ENGINE=deterministic` as above; the same lines give the same walker. While the dots show, say the next spoken line.
    - **Cisco Umbrella:** this laptop's network filter blocks the new vercel.app domain, so on this laptop always open localhost, never vercel.app. Gemini's API answered from this laptop during the 2026-10-23 rehearsal; Stripe wasn't checked then. Check both on the venue network during step 7.

## Requests to the product

Design changes that would make the demo better. These go to the redesign session; this script doesn't change the app.

1. **Show a "you said no" state.** After Wren declines voice, its panel says "Nothing you said points to this, but you can add it."†, which is wrong: she did say something. Pick: show the decline reason ("You said you'd rather not talk to it") in the panel and "You said no" on the part.
2. **Mark which engine answered each turn.** A quiet note under each acknowledgement ("read by Gemini" or "fixed questions: the model didn't answer in time") keeps us from passing a fallback off as the model, and turns a fallback into a real-world proof on stage. Pick: show it only while the agent is on.
3. **Draw new parts one at a time, with their names.** After L1 three parts appear at once, which is hard to read from the back of a room. Pick: stagger them about 300 ms apart, each with its name, and draw them instantly under reduced motion.
4. **Put her words first in the panel.** The moment to retell is "it says why in her own words", so the quote must read from a projector. Pick: lead the panel with "You said: “…”" in larger text, then the reason.
5. **End on the walker, not a receipt.** The success page is the last frame while the presenter is silent. Pick: show the saved walker drawing with its parts and "Demo order: no money moved" on the success page.
6. **One-click reset on the success page.** Resetting now takes "Back to your walker"† and then "Start over"†. Pick: a "Set up another walker" button on the success page that deletes the session and returns to a fresh first frame.
7. **A first frame that explains itself.** Judges walking up should get the idea before anyone speaks. Pick: a one-line caption under the bare frame ("Your walker starts as just the frame. Tell us what's hard."), and keep the example sentence in the empty text box.
8. **A QR code for the phone link.** Judges can try it themselves during Q&A. Pick: a small QR code for assistive-walker.vercel.app on the success page, with no tracking.

## Rehearsal results

**Date:** 2026-10-23. **Code:** my runs used branch `claude/demo-script` at `c2d3356`, the agent prompt and question bank before PR #20 and the redesign; the lead's rerun used PR #20's branch (below). **Method:** a scratch Vitest test (not committed) ran Wren's lines through the real onboarding service, `OnboardingService` with `MemorySessionStore`, in-process; no web page or browser was involved. Each path was a new session. For each turn the presenter's rule was applied: read the topic asked, type that topic's line. A path passed only if every topic came in the bank's order, the lit modules matched the expected list after every line, the final walker matched, the session reached review, voice was off, the robot arms were "worth considering", and no turn fell back. The expected results were written before the first run.

The 3-minute path is L1 to L5 then "skip the rest"; the 60-second path is L1 then "skip the rest"; the full path is L1 to L7.

| Engine and run | Path | Turns | Order as expected | Lit after every line as expected | Final walker | Fallbacks | Model time per turn |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Deterministic | full | 7 | yes | yes | intended | n/a | n/a |
| Deterministic | 3-minute | 5 | yes | yes | intended | n/a | n/a |
| Deterministic | 60-second | 1 | yes | yes | intended | n/a | n/a |
| Gemini run 1 | full | 7 | yes | yes | intended | 0 | 1.8 to 3.0 s, mean 2.4 |
| Gemini run 1 | 3-minute | 5 | yes | yes | intended | 0 | 2.1 to 2.7 s, mean 2.4 |
| Gemini run 1 | 60-second | 1 | yes | yes | intended | 0 | 2.7 s |
| Gemini run 2 | full | 7 | yes | yes | intended | 0 | 2.0 to 3.0 s, mean 2.4 |
| Gemini run 2 | 3-minute | 5 | yes | yes | intended | 0 | 2.0 to 2.6 s, mean 2.4 |
| Gemini run 2 | 60-second | 1 | yes | yes | intended | 0 | 2.3 s |
| Gemini run 3 | full | 7 | yes | yes | intended | 0 | 2.2 to 3.6 s, mean 2.5 |
| Gemini run 3 | 3-minute | 5 | yes | yes | intended | 0 | 2.2 to 2.7 s, mean 2.4 |
| Gemini run 3 | 60-second | 1 | yes | yes | intended | 0 | 2.1 s |
| **Lead's rerun on PR #20** (`claude/agent-wording` at `b23b1a9`, not merged) | | | | | | | |
| Deterministic | all three paths | | pass | pass | intended | n/a | n/a |
| Gemini, 3 of 3 runs | all three paths | 39 in all | pass | pass | intended | 0 | median 2.3 s, max 6.1 s |

Model: `gemini-3.7-flash` at low thinking. In my three runs, over all 39 agent turns: no fallbacks, no retries, 1.8 to 3.6 seconds, about 2.4 seconds on average. No line had to change. The agent read the same needs as the keyword matcher on every line, except that it also read "picking up" from L5 (already known from L1) and didn't add "easy controls" from the word "button" in L4 (already known from L1), so the lit modules matched. With the agent, the questions kept the bank's wording in every run.

**My Gemini runs are labelled "before the redesign prompt".** The lead reran on PR #20's new wording with the same result. Rerun both engines on `main` once PR #20 and the redesign land, because the redesign may still change the prompt and the question bank.

**Not verified here:** the page itself (the redesign isn't merged, so every † label, the Steady† name, the thinking dots, the reply's fade-in, the drawing and the popover are unchecked); tapped quick replies with the agent (only typed lines were rehearsed); a session where some turns fall back mid-conversation; how fast a turn fails with Wi-Fi off; the success page after a real test payment; the setup commands (no web server was started); Claude; and all hardware, which is planned.
