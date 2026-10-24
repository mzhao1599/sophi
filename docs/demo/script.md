# Steady: live demo script

**Steady. A smart walker you set up by talking to it.**

This is the script for showing the website to judges at Cal Hacks: a click sequence for the website alone, a 3-minute main script, a 60-second cut, the persona's exact lines, what each line should do with both onboarding engines, the honesty lines, judge Q&A, the setup checklist, and the rehearsal results. How to frame it for each sponsor track, with a 2-minute cut per track, is in [tracks.md](tracks.md). `pnpm --filter @walker/cloud-api rehearse` re-runs the rehearsal below (see "Rehearse on a model" in tracks.md).

**What is real today:** the website. A person types what they need, the onboarding assistant asks short questions, the walker drawing lights up suggested modules, and the person switches modules, saves the walker and orders it through Stripe's test mode. **What is planned:** the walker hardware (frame, hand controls, obstacle sensors, voice module, robot arms, arm lift) and location sharing. The parts are ordered; nothing is assembled or tested yet. Nothing in this script presents a planned part as working.

**Labels marked † are UI labels.** They were checked against the code on `main` (`daea268`, the Steady redesign) on 2026-10-23, not on the live page; the lead does the live page check. A polish change may still move small things (the logo mark, the Next.js badge), so re-check any † label that looks different on the day.

## Click sequence (website only)

Every input and click, with nothing to say. Use it to rehearse, or alongside the 3-minute script below. Wait for each reply to appear before typing the next line (about 2 to 3 seconds; "Read by Gemini" shows under each one).

1. Open <http://localhost:3004> (start it with the setup checklist below).
2. Click the text box, type the line below and press Enter:
   `I keep bumping into things, small buttons are hard, and I'd like help picking things up.`
3. Type `Around my apartment, and at the corner shop.` and press Enter.
4. Type `A buzz in the handles works best.` and press Enter.
5. Type `A button on my left handle. I'd rather not talk to it.` and press Enter.
6. Type `Mostly things I drop on the floor.` and press Enter.
7. Click "Show My Walker", under the text box.
8. On the drawing, click the "Obstacle sensors" label. Its panel opens with "You said:" and her words; press Escape to close it.
9. Click the "Voice" label. Its panel shows "You said no" and her words; press Escape.
10. In "All modules" on the right, switch on "Robot arms" and "Arm lift". Every part is now on screen, and the line under "Your walker" reads "5 modules · $1,675 sample total".
11. Click "Save".
12. Click "Order (Demo)". Stripe's test checkout opens.
13. On Stripe's page, fill in the fields below, then click "Pay":
    - Email: `demo@example.com`
    - Card: `4242 4242 4242 4242`
    - Expiry: `12/34`
    - CVC: `123`
    - Name: `Wren Demo`
    - ZIP: `94720`
14. The success page shows her walker and "Demo order: no money moved". To reset for the next run, click "Set up another walker".

If the assistant asks the questions in a different order, type the line that matches the question:

| If it asks… | Type the line from |
| --- | --- |
| where you'll use the walker | step 3 |
| how it should get your attention | step 4 |
| how you'd like to ask for help | step 5 |
| what you'd like to reach | step 6 |
| about sharing location, or anything else | don't type: click "Show My Walker" |

**Checked live on 2026-10-23** on a production build of `main` (`6a5d088`) at 1440 by 900, with the agent on:
- All five replies said "Read by Gemini", with no fallbacks.
- The walker came out with hand controls and obstacle sensors on, the robot arms and arm lift worth considering, and Voice "You Said No".
- The two switches made it 5 modules, and the Stripe test payment of $1,675.00 at the placeholder prices reached the success page.
- "Set up another walker" returned to a fresh first frame.

## The story

- **The arc:** one sentence in, a walker out. Wren says what is hard in her own words, and Steady draws the walker that helps her. She says no to one part and it's marked as her no, she sees why each suggested part is there, she switches on the experimental parts herself, and she orders it.
- **The first ten seconds:** the page is already open, and Wren's first sentence is already typed in the box. The presenter reads it aloud and presses Enter. There is no intro slide and no speech before the product moves.
- **The moment to retell:** "She typed one sentence, the walker drew itself, and every suggested part could say why it was there, in her own words." Two beats carry it: the parts arriving one at a time after the first line (0:10), and the panel that quotes her words back (1:33).
- **The ending:** by 2:01 every one of Steady's seven parts is on screen in its true state: the frame and everything she chose on, Voice marked "You Said No"†, and location sharing "Not Available Yet"†. The success page then ends on her drawn walker.
- **When the presenter stops talking:** three planned silences, each about 3 seconds. After the first Enter, let the walker draw. When "Your walker"† rises to centre stage, let it land. On the success page, stop and let the judges read it.
- **Who it's aimed at:** Microsoft's "Built for the Real World" judges first. The real-world points are made by the demo itself: no diagnosis asked, the person's "no" is respected and shown, the line under the text box says who reads her words and asks her to leave out names and medical details before she types, each reply says who read it, it keeps working when the model doesn't answer, it works without a mouse, and it is honest about what is a prototype.

## The persona: Wren

Wren is a **made-up person**. She has a first name only, no surname, no age and no medical details. She uses a walker around her apartment and to the corner shop. She keeps bumping into things, small buttons are hard for her, and she'd like help picking up things she drops. She would rather not talk to a machine.

**Her exact lines.** Type them as written. Each line is keyed by the question's topic. With the agent on, Gemini writes its own wording for each question (for example "Where will you mostly use it?"), so read what the question is about and type the line for that topic.

| # | Topic (the fixed questions' wording on `main`†) | Wren types | Words that must survive a typo |
| --- | --- | --- | --- |
| L1 | tasks ("Hi! What would you like a hand with?") | `I keep bumping into things, small buttons are hard, and I'd like help picking things up.` | "bumping into", "buttons", "picking things up" |
| L2 | places ("Where will you be using your walker?") | `Around my apartment, and at the corner shop.` | "apartment", "shop" |
| L3 | feedback ("How should the walker get your attention?") | `A buzz in the handles works best.` | "buzz" |
| L4 | start_request ("How would you like to ask the walker for help?") | `A button on my left handle. I'd rather not talk to it.` | "left handle", "rather not talk" |
| L5 | reach_detail ("What would you like help reaching?") | `Mostly things I drop on the floor.` | "drop", "floor" |
| L6 | location ("Would you like to share the walker's location?") | `Yes, so my family can see where the walker is.` | "where the walker is" |
| L7 | anything_else ("Anything else I should know?") | `No, that's everything.` | none |

The 3-minute script uses L1 to L5, then "Show My Walker"†. The 60-second cut uses L1, then "Skip"† and "Show My Walker"† ("Show My Walker"† only appears after two questions are answered or skipped). L6 and L7 are for a longer demo or for a judge who wants to see the whole conversation.

### What each line does, with both engines

"Lit" means the module's status is `recommended` (on, solid on the drawing, labelled "Suggested"† during the chat and "On"† on the "Your walker"† view) or `consider` (dashed, labelled "Worth Considering"† during the chat and "Suggested"† on the "Your walker"† view). The frame is always on ("Always Included"†) and isn't counted. Location sharing shows "Not Available Yet"† throughout.

| Line | Deterministic engine: next topic, lit after the line, its reply | Gemini agent (3 of 3 runs on `main`): next topic, what it read, model time |
| --- | --- | --- |
| L1 | places. Lit: hand controls, obstacle sensors (on); robot arms (dashed). "Got it, knowing what's in your way, buttons that are easy to press and help picking things up." | places, all runs. Read: obstacles, easy controls, picking up. Same lit set. 2.1 to 2.9 s |
| L2 | feedback. No change. "Good to know: at home and in shops and public buildings." | feedback, all runs. Read: home, shops. 2.0 to 3.5 s |
| L3 | start_request. No change. "Sounds good, a buzz in the handles." | start_request, all runs. Read: vibration. 2.1 to 2.6 s |
| L4 | reach_detail. Voice turns to "You Said No"† with a struck dot. "All right, buttons that are easy to press and a button on the left handle." (the fixed reply doesn't say the no back; the drawing does) | reach_detail, all runs. Read: left button; declined: asking out loud. Its reply says the no back (for example "A button on the left handle, without talking to it."). 2.1 to 2.7 s |
| L5 | location. Adds the arm lift (dashed). "Okay, things you've dropped." | location, all runs. Read: picking up, reaching low. Same lit set. 2.0 to 3.6 s |
| L6 | anything_else. No change. "Understood, sharing the walker's location once that's built." | anything_else, all runs. Read: location sharing. 2.0 to 2.3 s |
| L7 | review: "Here's your walker." No change. "Thanks for telling me." | review, all runs. Read: nothing. 1.8 to 2.3 s |

**The intended walker** after L5 (and after L7): hand controls and obstacle sensors on; robot arms and arm lift suggested but off until she switches them on; voice "You Said No"†; location sharing "Not Available Yet"†. After L1 alone (the 60-second cut): hand controls and obstacle sensors on, robot arms suggested but off, voice off ("Off"†, since she hasn't said anything about it).

**How to tell which engine answered.** On screen: under each reply the model worded, a quiet note says "Read by Gemini"†. A reply from the fixed questions instead says "Fixed questions: the model's reply didn't come through"†. A turn falls back when the model errors, runs past the 15-second deadline, or gives two unusable replies, and the next turn tries the model again. Backup: the terminal running the site prints `[onboarding-agent] outcome=agent …` for each model turn, or `outcome=fallback` with a reason. Carry on after a fallback: the rehearsal shows the same lines light the same parts either way. Never present a fallback turn as the model's; the note under it already says so.

## The 3-minute script

Each beat gives the presenter's line in quotes, then what happens on screen as numbered steps.

Before you start: the page is open at localhost, fresh (no answers), and L1 is already typed in the box, not sent. Pre-typing only enters the person's words early; the assistant still runs live when you press Enter.

**0:00 to 0:10. Cold open**

> "This is Wren. She's made up. She says: 'I keep bumping into things, small buttons are hard, and I'd like help picking things up.'"

1. The first frame shows "Let's build your walker."†, the bare frame and "Your walker starts as just the frame. Tell us what's hard."†
2. Read L1 aloud from the box as part of the line. Press Enter.

**0:10 to 0:23. The walker draws itself**

> "No diagnosis, no form. She said what's hard, and the walker drew the parts that help."

1. Thinking dots† show for about 2 to 3 seconds, then the reply fades in word by word†, with "Read by Gemini"† under it.
2. On the drawing, the parts arrive one at a time with their names: hand controls and obstacle sensors on, the robot arms dashed.
3. Say nothing for about 3 seconds while it draws, then say the line.

**0:23 to 0:36. Name it, and say where her words go**

> "This is Steady. The line under the box says her answers are kept temporarily for this setup, Google's Gemini reads them and Google may keep a copy, and it asks her to leave out names and medical details. Each reply says who read it."

1. Point at the name in the header, Steady†, then at the line under the text box†, then at "Read by Gemini"†.

**0:36 to 0:47. Where she'll use it (L2)**

> "One short question at a time. She can type, or tap an answer."

1. Type L2 while speaking: `Around my apartment, and at the corner shop.` Press Enter.

**0:47 to 0:57. How she'd like to be told (L3)**

> "She'd rather feel a buzz in the handles: a planned part, her choice."

1. Type L3: `A buzz in the handles works best.` Press Enter.

**0:57 to 1:15. Saying no (L4)**

> "And when she says no, it's recorded as a no."

1. Type L4: `A button on my left handle. I'd rather not talk to it.` Press Enter.
2. Point at Voice on the drawing: it now says "You Said No"†, with a struck dot.

**1:15 to 1:30. Only what's relevant (L5)**

> "It only asked about reaching because she mentioned picking things up. The arms and lift are dashed: they're the most experimental parts we plan to build, so they're never on by default."

1. Type L5: `Mostly things I drop on the floor.` Press Enter.
2. The arm lift arrives dashed, next to the arms.

**1:30 to 1:33. Stop whenever she likes**

> "She can stop at any point."

1. Press "Show My Walker"†.

**1:33 to 1:50. "Your walker"† (the moment to retell)**

> "Every suggested part tells her why it's there, in her own words. Fixed rules make the suggestion, not the model."

1. "Your walker"† rises to centre stage. Pause about 3 seconds before speaking.
2. Click "Obstacle sensors"† on the drawing. Its panel shows "You said"† with her words, then "Why it's suggested:"† and an on/off switch.

**1:50 to 2:01. She decides (every part, in its true state)**

> "The arms and lift are planned and experimental, so they start off. She decides: on. Now every part shows its true state: hers on, Voice 'You Said No', location 'Not Available Yet'."

1. Press Escape to close the panel.
2. In "All modules"† beside the drawing, switch on "Robot arms"†, then "Arm lift"†. Both turn solid on the drawing.
3. Point along the drawing: the frame, hand controls, obstacle sensors, robot arms and arm lift on; Voice "You Said No"†; Location sharing "Not Available Yet"†. The line under "Your walker"† now reads "5 modules · $1,675 sample total"†.

**2:01 to 2:10. No mouse needed (accessibility, 10 seconds)**

> "No mouse needed. Every part is a real button, the chat is built to be read by screen readers, and nothing needs voice."

1. Press Tab to move to a part on the drawing, Enter to open its panel, Escape to close it.
2. The keyboard pass was last done on 2026-10-23, before the redesign. Re-run it on the redesigned page before using this beat.

**2:10 to 2:42. Order it (demo)**

> "This is Stripe's test mode. Prices are placeholders, no money moves, and nothing ships."

1. Click "Save"†. "Saved"† appears.
2. Click "Order (Demo)"†. Stripe's test checkout opens with five modules, the arms and lift included, at placeholder prices. Say the line while typing the card.
3. Type the test card `4242 4242 4242 4242`, expiry `12/34`, CVC `123`, the name `Wren Demo`, ZIP `94720`, email `demo@example.com`. Ignore any Apple Pay or Google Pay button. Pay.
4. The success page shows "Demo order complete"†, "Demo order: no money moved"† and her drawn walker. Stop talking for about 3 seconds.

**2:42 to 3:00. Close**

> "Steady is a prototype, not a certified mobility aid. The hardware is planned, and the model will never control a motor. What's real: she said what's hard, and the walker drew itself around her. Try it on your phone at assistive-walker.vercel.app."

1. Leave the success page on screen.

## The 60-second cut

Same setup: a fresh page with L1 already typed in the box.

**0:00 to 0:10**

> "This is Steady. Wren is made up. She says: 'I keep bumping into things, small buttons are hard, and I'd like help picking things up.'"

1. Read L1 aloud as part of the line. Press Enter.

**0:10 to 0:21**

> "No diagnosis, no form. She said what's hard, and the walker drew the parts that help."

1. Thinking dots†, then the reply fades in†. Hand controls and obstacle sensors arrive on, robot arms dashed.
2. Pause about 2 seconds, then say the line.

**0:21 to 0:25**

> "She can skip, or stop any time."

1. Press "Skip"†, then "Show My Walker"†.

**0:25 to 0:37**

> "Every suggested part says why it's there, in her own words. Fixed rules pick the parts, not the model."

1. Click "Obstacle sensors"†. Its panel quotes her words under "You said"†.

**0:37 to 0:48**

> "Order runs in Stripe's test mode with placeholder prices. No money moves."

1. Press Escape. Click "Save"†, then "Order (Demo)"†. Show Stripe's test checkout page; don't pay.

**0:48 to 1:00**

> "It's a prototype, not a certified mobility aid, and the model never controls a motor. Steady: a smart walker you set up by talking to it. Try it at assistive-walker.vercel.app."

1. Leave the checkout page on screen.

## Optional beats

Use these only when they are true on the day.

- **The unplug beat (Built for the Real World).** Only if rehearsed on the venue network that day, and only if the projector is on a cable, not AirPlay. Before L4, turn Wi-Fi off and say "Hackathon Wi-Fi. Let's lose it." Type L4 and L5. The replies come from the fixed questions, and the note under each says so ("Fixed questions: the model's reply didn't come through"†). Say: "Those answers came from the fixed questions, not the model, and it's the same walker." Turn Wi-Fi back on before "Save"†, because Stripe needs the internet. Not verified: how fast the model call fails with Wi-Fi off. If it hangs, the turn waits up to the 15-second deadline before falling back.
- **Voice's panel.** Clicking Voice on the "Your walker"† view shows "You said no"†, quotes her decline under "You said"†, and gives the rule's reason. Use it if a judge asks what happens when someone says no.
- **Hardware, only if the walker is built.** Point at the physical walker and name only the parts that are on it and have been tested by the team that day. Say "planned" for everything else. Don't demo a part that hasn't been tested that day.
- **Location sharing (Meta's "Bringing People Closer Together"), only if built.** Today it shows "Not Available Yet"†, and the fixed reply to L6 says "once that's built". If you type L6, say: "She'd like her family to see where the walker is. It isn't built yet; Steady notes her answer."
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
- "The robot arms and arm lift are the most experimental parts. They're planned, and switching them on here only adds them to a demo order."
- No outside statistics. The only numbers here are our own rehearsal timings, and we say they're ours. Otherwise speak qualitatively ("people who use walkers need very different help").

## Judge Q&A

**1. What happens to what I type?** Answers are deleted an hour after the last change, or right away with "Start Over"†; the line under the text box says only that they're "kept temporarily for this setup"†. With the agent on, each answer is also sent to Google's Gemini API, and that line names Google and says Google may keep a copy, before anyone types. Once sent, deleting here can't recall it from Google. That's why the demo uses a made-up persona and the line ends "Please leave out names and medical details."†

**2. Does Google use it?** [Fill in from the setup checklist.] If the key's project is on Google's paid tier: Google doesn't use it to improve its products, and keeps it for a limited time to check for abuse. If it's on the free tier: Google can use it to improve its products, people may review it, and the terms say not to send sensitive or personal information. That's why the laptop only gets Wren's made-up lines. On the phone link tonight, no model runs, so nothing typed there goes to Google.

**3. Why don't you let the model choose the modules?** Because a suggestion about a mobility aid should be explainable and the same every time. The model only reads the person's words as a fixed list of needs, picks the next topic from a fixed list and words the question, and writes a one-line acknowledgement. It never picks a module. Fixed rules turn needs into suggestions, each with a reason that quotes the person's words, and the most experimental parts (the robot arms and the arm lift) are never switched on by default. If the model fails, the same rules still run, and the note under the reply says so.

**4. What if the internet or the model goes down?** Each turn has a 15-second deadline. If the model errors, runs past it, or gives two unusable replies, that turn is answered by the fixed questions and keyword matcher, the reply says "Fixed questions"†, and the next turn tries the model again. That fallback needs no internet. Stripe's test checkout does need the internet. On the planned walker, the design keeps controls, the stop and obstacle cues on the device so they don't depend on the internet; that's a design, not built.

**5. What will it cost?** We don't have a price. Every cost in our catalog is marked not measured, and checkout uses placeholder prices. The modular design is meant to let a person pay only for the parts that help them. We haven't measured what a setup conversation costs to run on the model either.

**6. Is it safe?** It's a prototype, not a certified mobility aid. The model is never given control of a motor. In the planned walker, any motion needs the person's own start signal, and a physical stop always wins. None of that hardware is built yet, so we make no safety claim today.

**7. Which model is it, and how fast?** Google's Gemini 3.7 Flash with low thinking. These are our own timings of the model's time per turn, measured in-process; the page adds a little on top. On `main` (2026-10-23, after the redesign), a turn took 1.8 to 3.6 seconds, with a median of 2.3 seconds, and no fallbacks over 39 turns. One typed turn through the production build took 2.9 seconds end to end. The provider sits behind one adapter, so it can also run on Anthropic's Claude.

**8. Have real walker users tried it?** Not yet. That's the next step: watch someone who hasn't seen it set up a walker without help, and note where they hesitate. The persona's lines were rehearsed against both engines, not tested with people.

**9. Does it work with a screen reader?** We built it with screen readers in mind, but haven't tested it with one yet. The chat is a live log. On the walker view, every part on the drawing is a real button†, and a list of the same switches sits beside it. Every step works by keyboard, by tapping, or by typing. We checked the whole flow by keyboard alone on 2026-10-23, before the redesign. A VoiceOver or NVDA pass is still to do.

**10. What's next?** Build and bench-test the walker (frame, stop switch, hand controls, obstacle sensors) and measure it; user testing with people who use walkers; a full screen-reader check; and connecting a saved setup to a real walker.

## Setup checklist (before judges arrive)

**Engines tonight.** The presenter's laptop runs the agent (Gemini) locally. The public site at assistive-walker.vercel.app stays on the built-in questions, so judges' phones get the deterministic engine. Both produce the same walker from Wren's lines.

**Run it as a production build.** A production build has no Next.js development badge and no slow first compile of each page, so nothing needs pre-warming for speed. The commands in steps 4 and 5 were run on 2026-10-23 in a worktree of `main` at `daea268`, on port 3004, with the results listed there. Port 3004 is used here because other projects on this laptop may use ports 3000 to 3003; any free port works if you change it everywhere.

1. **Code and dependencies.** In the main checkout, on the commit you'll demo:

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

3. **Port 3004 must be free.** This must print nothing:

   ```bash
   lsof -iTCP:3004 -sTCP:LISTEN
   ```

4. **Build.** The three Supabase variables are blanked so sessions stay in server memory and the local Supabase stack isn't needed. The `NEXT_PUBLIC_` ones are fixed into the page at build time, so they must be blank for the build too; values on the command line win over `.env.local`. It took about a minute and a half and wrote about 140 MB to `apps/web/.next`. Rebuild after any code change or `.env.local` change.

   ```bash
   NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= SUPABASE_SECRET_KEY= pnpm --filter @walker/web build
   ```

5. **Start.** In production, sessions in memory are refused unless `ONBOARDING_ALLOW_MEMORY_STORE=true`, which is fine for one laptop running one server.

   ```bash
   NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= SUPABASE_SECRET_KEY= ONBOARDING_ALLOW_MEMORY_STORE=true pnpm --filter @walker/web exec next start --port 3004
   ```

   Open <http://localhost:3004>. What the 2026-10-23 run gave: the server was ready in under a second; `/`, `/checkout/cancelled` and `/api/v1/checkout/status` answered 200, and the status said ordering is on (that check only reads the test key; it doesn't contact Stripe); the page held the name Steady and the notice "Google's Gemini reads them to choose each question, and Google may keep a copy"; and L1 sent through the API came back in 2.9 seconds with both new assistant turns marked `answered_by: "model"`, the next topic places, and hand controls, obstacle sensors and robot arms lit. The terminal printed `[onboarding-agent] outcome=agent attempts=1 reason=none ms=2824`.

6. **Fallback: development mode.** If the build fails, run the development server instead (not re-run on 2026-10-23; it shows a Next.js badge, and each page compiles slowly the first time it opens, so pre-warm in step 9):

   ```bash
   NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= SUPABASE_SECRET_KEY= pnpm --filter @walker/web exec next dev --port 3004
   ```

7. **Engine check.** The header says Steady†. The line under the text box† must include "Google's Gemini reads them to choose each question, and Google may keep a copy"†. After the first answer, the reply shows "Read by Gemini"† and the terminal prints `[onboarding-agent] outcome=agent …`. If the notice doesn't name Google, the deterministic engine is running: fix `.env.local`, rebuild and restart. Only if it names "Anthropic's Claude" may you mention Claude.
8. **Free-tier check.** Ask the key's owner whether its Google Cloud project has billing on, and write the answer into Q&A 2.
9. **Run it through once.** Run the whole 3-minute script once, end to end, including the test payment and the success page. This checks Gemini and Stripe on the venue network (and, in development mode, compiles every page). Then reset (step 13).
10. **Browser.** Use a separate browser profile with no saved data, so Stripe's email field can't autofill a real address. Close every other tab: email, chat, Messages, password managers, other localhost tabs (another project may use ports 3000 to 3003; the only localhost tab should be this demo on port 3004), any editor showing `.env.local`, and the vercel.app tab. Turn on Do Not Disturb.
11. **Projector zoom.** Zoom with Cmd+= to 110% or 125%. If the walker drops below the chat or the layout looks cramped, zoom out one step (Cmd+-). If mirroring sets the laptop to 1024 by 768, stay at 100%. Check this on the projector, since the redesigned layout's breakpoints weren't measured for this script.
12. **Stripe test card,** on a sticky note: `4242 4242 4242 4242`, `12/34`, `123`, `Wren Demo`, `94720`, `demo@example.com`. It's Stripe's public test card, not a secret.
13. **Reset between judges.** On the success page, press "Set up another walker"†: it deletes the answers and returns to a fresh first frame in one press. Anywhere else, press "Start Over"† in the header. Check the chat is empty and the walker is a bare frame, then type L1 into the box without sending it.
14. **Phone link for judges:** <https://assistive-walker.vercel.app>. The laptop can't open it (see Umbrella below), so check it on a phone on mobile data before judges arrive. It runs the built-in questions tonight: check that its notice doesn't mention Google. It keeps sessions in one server's memory, so a session can occasionally be lost: reload and start again. There's no QR code on the page, so put a printed QR card for the link on the table.
15. **Fallbacks.**
    - **No Wi-Fi:** the deterministic engine needs no internet. Restart with it so turns don't wait for the model's deadline: put `ONBOARDING_ENGINE=deterministic` at the front of the step 5 command (no rebuild needed). Stripe needs the internet, so without it stop at "Saved"† and show the order on a phone instead. A phone hotspot can bring back the internet.
    - **The agent is slow:** each turn falls back to the fixed questions after 15 seconds on its own, and the note under the reply says so. If turns take more than about 5 seconds, restart with `ONBOARDING_ENGINE=deterministic` as above; the same lines give the same walker. While the dots show, say the next spoken line.
    - **Cisco Umbrella:** this laptop's network filter blocks the new vercel.app domain, so on this laptop always open localhost, never vercel.app. Gemini's API answered from this laptop on 2026-10-23; Stripe wasn't contacted that day. Check both on the venue network in step 9.

## Requests to the product

Design changes for the demo, sent to the redesign session. Status checked against the code on `main` (`daea268`).

1. **Done.** A "you said no" state: Voice shows "You Said No"† with a struck dot, and its panel quotes her decline.
2. **Done.** A note under each reply saying which engine answered: "Read by Gemini"† or "Fixed questions: the model's reply didn't come through"†.
3. **Done.** New parts arrive one at a time, with their names.
4. **Done.** Her words come first in a part's panel: "You said"†, then "Why it's suggested:"†.
5. **Done.** The success page ends on her drawn walker, with "Demo order: no money moved"†.
6. **Done.** One-press reset on the success page: "Set up another walker"†.
7. **Done.** A first frame that explains itself: "Your walker starts as just the frame. Tell us what's hard."†, with the example "For example: small buttons are hard for me"† in the empty box.
8. **Skipped.** A QR code for the phone link on the page. Instead, put a printed QR card for <https://assistive-walker.vercel.app> on the table.
9. **New, optional.** The fixed questions' reply to L4 doesn't say the no back ("All right, buttons that are easy to press and a button on the left handle."), while the agent's does. The drawing still shows "You Said No"†, so this only matters after a fallback. Pick: have the fixed reply add the declined part ("…, and not talking to it").

## Rehearsal results

**Date:** 2026-10-23. **Code:** `main` at `daea268` (with PR #20's agent wording and PR #22's Steady redesign), in the worktree `claude/demo-script-update`. **Method:** a scratch Vitest test (not committed) ran Wren's lines through the real onboarding service, `OnboardingService` with `MemorySessionStore`, in-process; no browser was involved. Each path was a new session. For each turn the presenter's rule was applied: read the topic asked, type that topic's line. A path passed only if all of these held: every topic came in the bank's order; the lit modules matched the expected list after every line; the final walker matched; the session reached review; voice was off; the robot arms were suggested but off; no turn fell back; and every model reply was marked `answered_by: "model"` (none with the deterministic engine). The expected results were written before the first run.

The 3-minute path is L1 to L5 then "Show My Walker"; the 60-second path is L1 then "Show My Walker" (the Gemini runs) or L1, "Skip", then "Show My Walker" (the deterministic run, as performed on stage; skips never reach the model, so the model's part is the same L1 turn); the full path is L1 to L7.

| Engine and run | Path | Turns | Order as expected | Lit after every line as expected | Final walker | Fallbacks | Model time per turn |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Deterministic | full | 7 | yes | yes | intended | n/a | n/a |
| Deterministic | 3-minute | 5 | yes | yes | intended | n/a | n/a |
| Deterministic | 60-second | 1 + Skip | yes | yes | intended | n/a | n/a |
| Gemini run 1 | full | 7 | yes | yes | intended | 0 | 1.8 to 2.6 s, mean 2.3 |
| Gemini run 1 | 3-minute | 5 | yes | yes | intended | 0 | 2.0 to 2.9 s, mean 2.4 |
| Gemini run 1 | 60-second | 1 | yes | yes | intended | 0 | 2.8 s |
| Gemini run 2 | full | 7 | yes | yes | intended | 0 | 1.8 to 3.6 s, mean 2.5 |
| Gemini run 2 | 3-minute | 5 | yes | yes | intended | 0 | 2.1 to 2.4 s, mean 2.2 |
| Gemini run 2 | 60-second | 1 | yes | yes | intended | 0 | 2.1 s |
| Gemini run 3 | full | 7 | yes | yes | intended | 0 | 2.0 to 3.5 s, mean 2.5 |
| Gemini run 3 | 3-minute | 5 | yes | yes | intended | 0 | 2.0 to 2.6 s, mean 2.3 |
| Gemini run 3 | 60-second | 1 | yes | yes | intended | 0 | 2.7 s |

Model: `gemini-3.7-flash` at low thinking. Over all 39 agent turns: no fallbacks, no retries, 1.8 to 3.6 seconds, a median of 2.3 seconds. No line had to change. Every run read the same needs from each line, and they matched the keyword matcher's, except that the agent also read "picking up" from L5 (already known from L1) and didn't add "easy controls" from the word "button" in L4 (already known from L1), so the lit modules matched. The agent wrote its own question wording, which varied between runs (for example "Where will you mostly use it?" and "Where will you mostly use the walker?"), but the topic order never changed.

**The "she decides" beat and the order.** A second scratch test, in the web app's own code, ran the 3-minute path, then the page's own switch logic: Robot arms on, then Arm lift on. Before the switches, all seven parts were in the expected states (frame, hand controls and obstacle sensors on; voice "You said no"; arms and lift suggested but off; location sharing unavailable). After them, the arms and lift were on with nothing else changed, the selection had no problems, and Save confirmed five modules. The Stripe line items built from that setup were the frame, hand controls, obstacle sensors, robot arms and arm lift, each at its placeholder price from `apps/web/src/server/checkout/order.ts` and labelled "demo price, not a real quote". (Since `8cc072e` on 2026-10-24, each line's name ends "(sample price)" instead; the note on Stripe's page still says "Prices are demo prices, not a real quote.")

**Earlier runs.** The same lines also passed with both engines on `c2d3356` (before PR #20 and the redesign) and on PR #20's branch at `b23b1a9` (the lead's rerun).

**Not verified here:** the live page, which the lead checks: the † labels as rendered, the thinking dots, the word-by-word fade-in, the parts arriving, the panels, the switches in "All modules"†, Escape and the keyboard pass after the redesign. Also not verified: tapped quick replies with the agent (only typed lines were rehearsed); a session where some turns fall back mid-conversation; how fast a turn fails with Wi-Fi off; a real test payment and the success page after it (the Stripe line items were checked in code, not in Stripe); the projector zoom on the redesigned layout; Claude; and all hardware, which is planned.
