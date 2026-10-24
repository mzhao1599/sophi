# Steady on the walker: live demo script

**Steady. A smart walker you set up by talking to it, and that you can talk to every day after.**

This is the script for showing the always-on walker assistant to judges at Cal Hacks (October 23 to 25, 2026). It has:
- a click and speak sequence for the six beats, with the presenter's exact spoken lines and fresh-wording alternates;
- what the "Your walker" page shows at each beat;
- the honesty lines and judge Q&A;
- a 60-second cut, and how this joins the onboarding demo in one 3 to 4 minute run;
- a setup checklist for two cases: the simulator on the Mac (tonight), and the real Pi on Max's phone hotspot with the server on Render;
- the rehearsal results, with timings.

The onboarding demo's script is [script.md](script.md); it stays the source for Wren's lines and the website setup. Sponsor-track framing is in [tracks.md](tracks.md).

**What is real today:**
- the walker assistant's server, with pairing, heartbeats, the assistant turn on Google's Gemini, offers and Confirm, on Postgres;
- the Pi service, which runs here as the simulator on a Mac;
- the "Your walker" page.

**What is simulated tonight:** the whole walker. The simulator stands in for the Raspberry Pi's buttons, microphone and speaker, the hand controls and the obstacle sensors. The page labels every one of them "Simulated", and the whole walker "Simulator".

**What is planned or unverified:**
- the real Pi, which isn't connected yet;
- the ESP32 hand and obstacle boards, whose firmware is tested on a computer but hasn't run on a board;
- Cartesia's voice, which has no key yet.

Nothing in this script presents a simulated or planned part as working.

**Labels.** UI text in quotes was seen on screen at 1440 by 900 in the rehearsal on 2026-10-24 (production build of `main` at `beab832`). Text marked † wasn't seen on screen; check it on the day. The walker's own spoken lines are quoted from the simulator's log.

## The six beats at a glance

| Beat | Presenter does | The walker | The page |
| --- | --- | --- | --- |
| 1. Boot | Starts the walker | Says "Steady is on." | Online, each part with its health and "Simulated", the "Simulator" badge, alerts "Applied" |
| 2. Ask | Holds Talk: "What can you help me with?" | Answers out loud | "You said (as heard by Gemini)", the reply, "In the walker's own voice" |
| 3. Obstacles | Hand in front of the sensor, then asks "Is anything in front of me?" | Buzzes the handle at once (local), then answers with the distance and "These readings are simulated." | Front left about 30 cm, "Simulated" |
| 4. Change a setting | Asks "Stop buzzing me, use short sounds instead.", then presses Confirm | "I can switch your alerts from buzzing to short sounds. Press Confirm to do it.", then "Done. Obstacle alerts now use short sounds." A hand in front now gives the short sound, no buzz | The offer card, then "Version 2", "Short sounds", "Applied" |
| 5. Arms | Asks "Can you pick up my keys?" | "This walker doesn't have robot arms, so I can't pick things up or move things." | The same line, "Answered by the fixed replies" |
| 6. Offline | Turns off the walker's network | A Talk press gets "I'm offline right now. Your short-sound alerts still work." at once | "Offline", every part "Unavailable", every zone "Unknown"; it comes back when the network does |

## Click and speak sequence

Every action and line, in order. Before judges arrive, the walker is paired and on, and the page is open at `/walker` with the walker showing "Online" (see the setup checklist).

**Talk, on each setup.**
- **Real Pi:** hold the Talk button while you speak, then let go.
- **Simulator:** press `t` in the simulator's terminal, speak, then press `t` again to send. A terminal can't see a key being released, so the simulator's Talk toggles.

The reply's text reaches the walker 2 to 6.5 seconds after you let go, and the walker then speaks it (see the rehearsal results; the time until it's heard isn't measured). Wait for the answer before the next line.

### Beat 1. Boot (0:00 to 0:15)

> "This is Steady on the walker. It runs whenever the walker is on, and nothing listens until I hold Talk."

1. Start the walker. The Pi starts on its own at power-on; for the simulator, start it with the command in the setup checklist.
2. The walker says "Steady is on."
3. Within about 2 seconds the page shows:
   - "Online";
   - the drawing with each part and its health: Hand controls, Obstacle sensors, Voice, Walker and coordinator, each "Healthy";
   - in the simulator, every part also says "Simulated", and the "Simulator" badge shows with "This walker is the simulator running on a computer, not a Pi.";
   - "Alerts": "Vibration in the handles", "Spoken messages", "Applied".
4. The obstacle readings appear about 5 seconds after boot ("No obstacle sensors reporting." until the first reading arrives).

### Beat 2. Ask (0:15 to 0:35)

> "I'll ask it what it can do."

1. Talk: **"What can you help me with?"**
2. The walker answers out loud. Rehearsed answers, in the model's own words, for example: "I can check obstacle readings, report on your walker's parts, or change how you receive alerts."
3. Point at the page:
   - "You said (as heard by Gemini)" and your words;
   - the reply;
   - "In the walker's own voice" under it. That note changes to "In Cartesia's voice"† once the server has a Cartesia key.

> "Gemini heard that and wrote the answer. The page shows both sides, so voice is never the only way to follow it."

### Beat 3. Obstacles (0:35 to 1:00)

> "The obstacle cue is local: no internet, no model."

1. Put a hand in front of the sensor. In the simulator, press `n` (a hand at 30 cm, front left).
2. The handle buzzes at once. In the rehearsal the buzz went out within 0.1 s of the hand; the simulator logs "SIMULATED handle buzz".
3. Within a few seconds (the walker reports every 5 seconds) the page's "Obstacles" shows "Front left 30 cm", "Simulated".
4. Talk: **"Is anything in front of me?"**
5. The walker answers with the measured distance and how fresh it is, and in the simulator adds "These readings are simulated." It never says the way is clear: a missing, invalid or old reading is "unknown".
6. Take your hand away (simulator: press `f`).

> "If a reading is missing or old, it says unknown, never clear. And here every reading is from the simulator, and it says so."

The page's distance comes from the walker's report every 5 seconds, so it can read "measured 3.0 s ago"; the spoken answer uses the reading the walker had when you let go of Talk ("just now"). Both are true.

### Beat 4. Change a setting (1:00 to 1:35)

> "The buzz is too much. I'll ask for something else."

1. Talk: **"Stop buzzing me, use short sounds instead."**
2. The walker says: "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." This line is written by the server from the change itself, never by the model.
3. The page shows the offer card:
   - "Steady offers";
   - "Switch your alerts from buzzing to short sounds.";
   - "Now", "After";
   - "Confirm" and "Decline";
   - "Expires in 0:5x";
   - "Or press Confirm on the walker."
4. Press Confirm on the walker (simulator: `c`), or Confirm on the page.
5. The walker says "Done. Obstacle alerts now use short sounds."
6. The page's card says "Confirmed. Switching your alerts to …", and "Alerts" changes to "Version 2", "Short sounds", "Spoken messages". It shows "Waiting for the walker"† until the walker reports it has applied the change, then "Applied". In the rehearsal "Applied" took 2 to 9 seconds after Confirm; keep talking meanwhile.
7. Hand in front again (simulator: `n`, then `f`): now a short sound, no buzz.

> "The model can only offer. Nothing changed until I pressed Confirm, and the page only says 'Applied' when the walker itself reports it."

### Beat 5. Arms (1:35 to 1:50)

1. Talk: **"Can you pick up my keys?"**
2. The walker says: "This walker doesn't have robot arms, so I can't pick things up or move things."
3. The page marks it "Answered by the fixed replies": when the model marks a question as about the arms (a structured field, not word matching), the server replaces the reply with a fixed line built from what the walker reports.

> "There are no arms on this walker, and nothing in this build can move anything. It says so instead of pretending."

### Beat 6. Offline (1:50 to 2:30)

> "Now it loses the internet."

1. Cut the walker's network:
   - **Real Pi:** turn off the phone hotspot the Pi is on. The laptop stays on venue Wi-Fi, so the page keeps working.
   - **Simulator:** see the setup checklist. Tonight's simulator can't cut its own link to a real server yet.
2. After about 6 to 10 seconds the walker counts itself offline (measured on a relay that refused connections at once; on a hotspot that drops packets, each try can wait out its 5-second deadline, which isn't measured) and says, once: "I'm offline right now. Your short-sound alerts still work."
   - It names the alerts in force now, so after beat 4 it says short sounds.
   - In the simulator it adds "The obstacle sensor is simulated."
3. Talk (any line): the walker answers at once with the same offline line. It records nothing and doesn't reach the model.
4. The page shows "Offline" with "last seen", every part "Unavailable" and every zone "Unknown" (about 13 to 16 seconds after the cut).
5. Turn the network back on. Once offline, the walker retries after 10 seconds and then every 15 seconds (and at once when Talk is pressed), so it's back within about 15 seconds of the network returning, plus the hotspot's own rejoin time, which isn't measured. Pressing Talk once the network is back brings it back sooner. It says "I'm back online." The page shows "Online", and its conversation now holds the lines the walker said while offline, marked "On the walker" and "On the walker, offline reply".

> "Buttons and obstacle cues never needed the internet. When it's back, the page catches up with everything the walker said."

## The spoken lines

Only the presenter speaks to the walker: the Gemini key is on the free tier, which is for scripted, made-up lines (see the honesty lines). Judges type on the page instead. The alternates marked "(rehearsed)" ran once each in the fresh run below and gave the same results; the others haven't been tried.

| Beat | Line | Alternates | Must come back |
| --- | --- | --- | --- |
| 2 | "What can you help me with?" | "What are you able to do for me?" (rehearsed); "What can you do?" | A short list of what it can do (obstacles, parts, alerts). Model-written, so the wording changes each time |
| 3 | "Is anything in front of me?" | "Is there something ahead of me right now?" (rehearsed); "How far is the nearest thing?" | The measured distance with its freshness, and in the simulator "These readings are simulated." Never "clear" |
| 4 | "Stop buzzing me, use short sounds instead." | "I'd rather hear beeps than feel the handles shake." (rehearsed); "Can you use sounds instead of vibration?" | Exactly "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." (server-written) |
| 5 | "Can you pick up my keys?" | "Could you grab the glasses I dropped?" (rehearsed); "Can you reach the shelf for me?" | Exactly "This walker doesn't have robot arms, so I can't pick things up or move things." |
| 6 | Any line while offline | | "I'm offline right now. Your short-sound alerts still work." (plus "The obstacle sensor is simulated." in the simulator) |

**For judges, typed on the page.** Click "Ask Steady about your walker", type, press Enter. The page shows "You typed", and the reply arrives in about 2 seconds. Suggested lines:
- "Which of your parts are simulated?"
- "Are any of your parts not real hardware?"
- "Is anything in front of me?"

The notice above the box says where typed words go: Gemini, which may keep a copy; Cartesia, for the text of spoken replies; and that each message is deleted an hour after it's sent. Point at it before a judge types.

## Honesty lines

Say these when they come up, in these words or close to them.

- **What's simulated:** "This is the simulator on a laptop. Every part marked Simulated is a stand-in, and the page says Simulator for the whole walker." On the real Pi: "The Pi, its buttons, microphone and speaker are real. Anything still marked Simulated is a stand-in."
- **Who hears and who speaks:** "Google's Gemini hears my voice and writes the answer. Tonight the walker reads the answer out with its own voice, and the page says so. With a Cartesia key, Cartesia speaks it, and only Steady's reply text goes to Cartesia, never my voice."
- **Why judges type:** "Our Gemini key is on the free tier, which is for scripted, made-up lines, and Cartesia's terms allow it to train on what it receives, so only I speak to it. You can type on the page; the notice says where typed words go."
- **What it can change:** "The model can only offer one change: how alerts reach you. Nothing changes until a person presses Confirm, and the offer expires after a minute. Voice can't confirm."
- **Motion:** "Nothing in this build can move the arms or the lift. There is no motion command at all."
- **Obstacles:** "The buzz is a proximity cue from the walker itself, not collision avoidance. A missing or old reading is unknown, never clear."
- **Numbers:** only our own timings, and say they're ours (the rehearsal results below). The hardware isn't measured: the boards' firmware has been tested on a computer, not on a board.
- **What's kept:** "Voice clips are sent to Gemini for one answer and dropped; Steady never stores them. Google's free tier may keep what it receives. The words and replies are deleted from Steady after an hour, or at once with Forget this walker."
- **It's not Wren's walker:** if this follows the onboarding demo, "Wren's setup has voice off; this is a walker set up with voice on."

## Judge Q&A

**1. Is it always listening?** No. Nothing records until Talk is pressed, and it stops at release, or after 15 seconds. There's no wake word. The model never speaks unprompted; the walker's own lines (it's on, offline, back online, pair me again) are fixed and written in the Pi's code.

**2. What happens to my voice?**
- The clip goes to Google's Gemini with that one question, is held in memory for the turn, and is then dropped. Steady never stores or logs it.
- The transcript and the reply are kept for an hour, so the page can show the conversation. "Forget this walker" deletes them at once.
- Typed words go to Gemini too. A reply the walker speaks goes to Cartesia as text when the server has a Cartesia key; replies to typed questions on the page aren't spoken, so they don't.
- On the free tiers, Google and Cartesia may use what they receive, so only scripted, made-up lines go to them.

**3. Why does it need Confirm?** A model's answer is never authority to change the walker. The model may offer one change, and the server checks it against fixed rules: a cue the walker can deliver, and never turning obstacle alerts off. The server writes the offer's words from the change itself. The change happens only when a person presses Confirm, by the offer's id, within a minute. The first answer wins. A second Confirm sees it's already done.

**4. What if the internet goes down?** The buttons and obstacle cues keep working on the walker. It says it's offline and answers Talk with a local line built from its current settings. It catches up when the network returns, and the page then shows everything it said. Measured on the simulator, with a relay that refused connections at once: the walker counted itself offline 6.5 to 9.9 seconds after the cut and answered Talk at once. Once offline it retries after 10 seconds and then every 15 seconds, so it's back within about 15 seconds of the network returning (6.6 to 7.6 seconds in the rehearsal, by where the restart fell in that wait).

**5. What if the model is slow or fails?** A turn has 8 seconds on the server. If the model errors, refuses, gives two bad replies or runs out of time, a fixed answer built from the walker's status is used, and the page marks it "Answered by the fixed replies". If the server's answer doesn't arrive within 10 seconds, the walker gives up, counts itself offline and says its offline line. In the rehearsal no spoken turn needed the fallback, apart from the arms question, whose fixed line is the rule.

**6. Can it move?** No. There is no motion command anywhere in this build. The only thing the walker can make a part do is play one of four fixed haptic patterns, for at most a second.

**7. How fast is it?** These are our timings from the rehearsal below, on a laptop with the simulator: from releasing Talk to the reply's text arriving, 2.1 to 6.3 seconds, with a median of 3.0 seconds, over 16 spoken turns; 3 of them took over 4 seconds. The walker then has to say it: the Pi writes the whole line with its own voice before playing it, so the time until it's heard is longer, and we haven't measured it. The target in our design is 4 seconds to the start of a spoken answer. The real Pi isn't measured yet.

**8. Which models?** Google's Gemini (`gemini-3.7-flash`) hears the clip and writes the answer in one call. Cartesia's text-to-speech (`sonic-3.6`, a stock voice; no one's voice is cloned) speaks it once the server has a key. Tonight there's no Cartesia key, so the walker speaks with its own voice.

**9. Who can see the page?** The browser that paired the walker, through a cookie; there are no accounts yet. A walker is paired with a one-time 6-digit code that lasts 10 minutes. The walker gets its own key, and the server keeps only a hash of it. Five wrong codes lock pairing for 10 minutes.

**10. Does it work without sight or speech?** Every spoken answer also appears on the page. Every offer can be confirmed from the page or the walker's button. The page works by keyboard and announces new replies, walker lines and offers once through a polite live region. It was checked by keyboard alone, at 390 px wide and at 200% zoom, and with reduced motion, in a headless browser against the page's development fake on 2026-10-24. A VoiceOver or NVDA pass is still to do.

**11. What's real hardware here?** Tonight, none of it: it's the simulator, and the page says so on every part. The real Pi isn't connected yet. The ESP32 firmware for the hand controls and obstacle sensors compiles and is tested on a computer, but hasn't run on a board.

## The 60-second cut

The walker is paired, on and "Online"; the page is open.

**0:00 to 0:10**

> "This is Steady on the walker. Nothing listens until I hold Talk, and everything it hears or says shows up here."

**0:10 to 0:25**

1. Talk: "What can you help me with?" Point at "You said (as heard by Gemini)" and the reply.

**0:25 to 0:50**

1. Talk: "Stop buzzing me, use short sounds instead."
2. When it says "Press Confirm to do it", press Confirm.
3. Say the line while the alerts go to "Applied":

> "The model can only offer. It changed when I pressed Confirm, and the page says Applied only once the walker reports it."

**0:50 to 1:00**

> "Nothing here can move a motor, the parts marked Simulated are stand-ins, and it keeps its alerts working offline. That's Steady."

## Joined with the onboarding demo (3 to 4 minutes)

1. **0:00 to 1:00:** the onboarding demo's [60-second cut](script.md#the-60-second-cut), stopping on Stripe's checkout page (don't pay).
2. **1:00 to 1:10, the bridge:**

   > "That's setting up a walker. This is the walker every day after. It isn't Wren's: her setup has voice off. This one has voice on."

   Switch to the walker page (a second browser tab, already open and "Online").
3. **1:10 to 3:10:** beats 2 to 6 above, from "What can you help me with?" to the walker coming back online. Skip beat 3 if time is short.
4. **3:10 to 3:30, the close:**

   > "Steady is a prototype, not a certified mobility aid. The model never controls a motor, and every simulated part says so. What's real: she said what's hard, the walker drew itself around her, and every day after, a walker like this one can just be asked."

## Setup checklist

### A. Tonight: the simulator on the Mac

Everything runs on one laptop: the web app as a production build on port 3009, a local Postgres, and the walker simulator.

1. **Code and tools.** In the main checkout, on the commit you'll demo:

   ```bash
   pnpm install
   ```

   ```bash
   pnpm --filter @walker/pi bundle
   ```

   Postgres 17 from Homebrew (`brew install postgresql@17`, if `/opt/homebrew/opt/postgresql@17/bin/initdb` doesn't exist), and `ffmpeg` for the Mac microphone (`brew install ffmpeg`).

   **As run in the rehearsal:** the build and start commands below, with the database in a scratch folder. The pair and simulate commands differed: the rehearsal used a scratch state folder, the relay on port 3019, recorded clips and the patched bundle (see the rehearsal results). Run steps 6 and 7 once as written before judges arrive.
2. **Settings.** `apps/web/.env.local` needs `GEMINI_API_KEY`. Check the names without showing values:

   ```bash
   sed 's/=.*//' apps/web/.env.local
   ```

   No `CARTESIA_API_KEY` means the walker speaks with its own voice. The page then says "In the walker's own voice", and you should say so.
3. **A throwaway database** (once). The folder path must be short, or Postgres can't create its socket; with `unix_socket_directories=''` it listens on TCP only:

   ```bash
   /opt/homebrew/opt/postgresql@17/bin/initdb -D ~/steady-demo-pg -U steady --auth=trust
   ```

   ```bash
   /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D ~/steady-demo-pg -o "-p 55433 -c unix_socket_directories='' -c listen_addresses=localhost" -l ~/steady-demo-pg.log start
   ```

   ```bash
   /opt/homebrew/opt/postgresql@17/bin/createdb -h localhost -p 55433 -U steady steady
   ```

4. **Build** (about 30 seconds; the Supabase variables are blanked so the onboarding page keeps sessions in memory):

   ```bash
   NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= SUPABASE_SECRET_KEY= pnpm --filter @walker/web build
   ```

5. **Start.** The walker routes need Postgres in production; the tables are created at startup:

   ```bash
   NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= SUPABASE_SECRET_KEY= ONBOARDING_ALLOW_MEMORY_STORE=true DATABASE_URL=postgres://steady@localhost:55433/steady pnpm --filter @walker/web exec next start --port 3009
   ```

   Check that <http://localhost:3009/api/v1/health> says `{"status":"ok","walker_store":"postgres"}`.
6. **Pair.** Open <http://localhost:3009/walker> and press "Get a pairing code". In a terminal:

   ```bash
   node devices/pi/dist/walker.mjs pair <the 6-digit code> --server http://localhost:3009 --state ~/steady-sim
   ```

   It prints "Paired as device …", and the page switches to the walker ("My walker").
7. **Start the walker,** with the Mac's microphone (it records only between the two `t` presses, but it hears whoever is near the laptop then, and macOS asks for permission the first time):

   ```bash
   node devices/pi/dist/walker.mjs simulate --server http://localhost:3009 --state ~/steady-sim --mic mac --loud
   ```

   - `--loud` plays its speech through the speakers; without it, speech is written to files.
   - Keys:
     - `t`: Talk (press, speak, press again);
     - `c`: Confirm;
     - `n`: a hand in front;
     - `f`: nothing in front;
     - `q`: quit.
   - **Not rehearsed:** the rehearsal used recorded clips instead of `--mic mac` and `--loud`. Run beats 1 to 5 once with your own voice before judges arrive.
8. **Beat 6 in the simulator.** With `--server`, the simulator's network keys (`o`, `g`) don't work, and turning off the laptop's Wi-Fi doesn't cut a walker that talks to `localhost`. Until the simulator can cut its own link (see "Requests" below), skip beat 6 and say: "On the real walker, turning off its hotspot takes it offline, and it keeps its alerts working."
9. **Screen.** Put the browser and the simulator's terminal side by side; the terminal is the walker's buttons. Click once on an empty part of the page, so the walker's name doesn't keep the focus ring it gets when the page switches to the walker. Close everything else. Do Not Disturb on.
10. **Reset between judges.** On the page, "Forget this walker", then pair again (step 6) and restart the walker (step 7), so each judge sees the same starting state (vibration alerts, version 1).

### B. The real Pi on Max's phone hotspot, server on Render

Needs Max. None of the Pi steps has been run yet.

1. **Render** (Max, once): follow [Deploy on Render](../../apps/web/README.md#deploy-on-render). Paste `GEMINI_API_KEY`, and `CARTESIA_API_KEY` if there is one (or `none`). Check that `/api/v1/health` on the Render address says `{"status":"ok","walker_store":"postgres"}`. If this Mac's network filter blocks `onrender.com`, open the page on a phone or iPad.
2. **The Pi** (Max): follow the Pi checklist in [devices/pi/README.md](../../devices/pi/README.md#set-up-the-pi-maxs-checklist-every-step-unverified):
   - OS and Node 22;
   - Talk on GPIO17 and Confirm on GPIO27, declared with `WALKER_GPIO_BUTTONS=wired`;
   - a USB microphone and speaker;
   - the systemd service.

   Each step there says what to check.
3. **Network:** the Pi joins Max's phone hotspot, and the laptop stays on venue Wi-Fi. That way, turning off the hotspot (beat 6) takes only the walker offline.
4. **Pair:** open `/walker` on the Render address, press "Get a pairing code", and on the Pi run the pair command from the Pi checklist with `--server https://<the Render address>`. The page switches to the walker. On a sleeping free server the first request can take a minute: the Pi wakes it before using the code.
5. **Obstacle sensors and hand boards:** their firmware hasn't run on a board. If no sensor board is connected, the page shows "No obstacle sensors reporting." In that case skip beat 3, and in beat 4 say the cue change is saved for when the sensors are fitted. If no hand board is connected, Talk and Confirm are the Pi's GPIO buttons.
6. **Cartesia,** only with a key: the page says "In Cartesia's voice"† under spoken replies. Its terms (read 2026-10-24) allow training on inputs unless agreed otherwise, so the same scripted-lines-only rule as Gemini's free tier applies.
7. **Run it once** on the venue network: all six beats, including the hotspot off and on. Time beat 6's return on the real hotspot; it isn't measured.
8. **Card on the walker:** "Only the presenter speaks to this walker. Type on the page instead; it says where typed words go."

## Requests

Found in the rehearsal; each has an owner. None is in the page.

1. **Pi: one clip per run.** `walker simulate --mic-file` reads its clip once, so a run can only ever say one line. The rehearsal patched a scratch copy of the bundle to re-read the file at each Talk press. Smallest fix: re-read the `--mic-file` clip at each Talk press, as the rehearsal's patch did, so a script can swap the file between presses.
2. **Pi: no offline switch against a real server.** With `--server`, the simulator's `o` and `g` keys only work with the fake cloud, so beat 6 can't be shown with the simulator. The rehearsal put a relay between the simulator and the server and stopped it. Smallest fix: with `--server`, make `o` and `g` fail or hang the HTTP client's requests in the simulator itself.
3. **Server: a repeated "simulated" line.** On a walker whose every part is simulated, a "which parts…" answer gets "Some of this walker's parts are simulated." appended, after the model already said all of them are, for example "All of my parts are currently simulated… Some of this walker's parts are simulated." Smallest fix: when every reported part is simulated, append "All of this walker's parts are simulated." instead. (Not on `simulator` alone: a simulator can have a real part plugged in.)
4. **Pi: "Applied" lags Confirm.** The page shows "Applied" only after the walker's next heartbeat reports the new version. That took 2.2 to 9.4 seconds after Confirm in the rehearsal (median 4.4 s). Smallest fix: send a heartbeat as soon as a new configuration is applied.
5. **Pi: the same offline sentence twice.** Going offline, the walker says "I'm offline right now. …" once, and a Talk press then gets the same sentence. The page lists both, as "On the walker" and "On the walker, offline reply". It's correct, but reads repetitive; optional.

## Rehearsal results

**Date:** 2026-10-24, 04:38 to 04:44 PDT (the four runs; times from the simulator's logs). An earlier run at about 04:35 used a simulator bundle built from the previous branch, before #36, so "Walker and coordinator" read "Unavailable". The server's log shows its turns, offer, Confirm and arms answer went through; its results weren't kept, so it isn't in the table. **Code:** `main` at `beab832`, which includes the server (#31), the assistant turn (#39), the page (#34) and the Pi service with `base.walker` (#36). **Setup:**
- a production build of `apps/web` on port 3009, with a throwaway Postgres 17 (Homebrew) on port 55433 as `DATABASE_URL`;
- Max's Gemini key from `apps/web/.env.local`, and no Cartesia key, so every spoken reply was offered "In the walker's own voice";
- the walker simulator from `devices/pi` (bundled from `beab832`), paired from the page each run and talking to the server through a local relay on port 3019 (stopping the relay was beat 6's network cut);
- a headless Chromium at 1440 by 900 driving the page by keyboard;
- a pty driver pressing the simulator's keys.

**The spoken lines were synthetic.** macOS `say` read each line into a 16 kHz mono WAV, passed with `--mic-file`. Nothing played aloud. A scratch copy of the simulator's bundle was changed in one place, to re-read the clip at each Talk press (request 1); nothing else in it changed. Times come from the simulator's log (millisecond timestamps), the speech files' write times, and the page.

**Results.** Four runs: three with the scripted lines and the walker's Confirm, then one with fresh wordings and the page's Confirm. All four passed every beat:

| Run | 1. Boot | 2. Ask | 3. Obstacles | 4. Setting | 5. Arms | 6. Offline | Typed on the page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scripted 1 | pass | pass, 2.8 s | pass, 3.1 s | pass, 4.8 s, Applied 3.7 s | pass, 6.3 s | pass | 1.9 s |
| Scripted 2 | pass | pass, 2.7 s | pass, 2.9 s | pass, 3.4 s, Applied 5.2 s | pass, 3.7 s | pass | 2.5 s |
| Scripted 3 | pass | pass, 2.1 s | pass, 2.6 s | pass, 3.8 s, Applied 2.2 s | pass, 2.6 s | pass | 1.9 s |
| Fresh (page Confirm) | pass | pass, 3.0 s | pass, 2.8 s | pass, 2.9 s, Applied 9.4 s | pass, 4.4 s | pass | 1.9 s |

Spoken beats give the time from releasing Talk to the reply's text arriving on the walker. "Applied" is from Confirm to the page showing "Applied". "Typed" is from Enter to the reply on the page.

**What each beat checked, every run:**
- **Boot:** "Steady is on." 0.1 s after start; the page "Online" within 1.5 s; every part "Healthy" and "Simulated", including "Walker and coordinator"; alerts "Version 1", "Applied".
- **Ask:** "You said (as heard by Gemini)" with the exact words, answered by the model, "In the walker's own voice".
- **Obstacles:** the handle buzz within 0.1 s of the hand; when the page was read 6.5 s after the hand, it showed "Front left 30 cm" "Simulated", measured 2.8 to 4.5 s earlier; the answer gave 30 cm and 1.5 m and "These readings are simulated."; never "clear".
- **Setting:**
  - the exact server line and the offer card;
  - Confirm gave configuration version 2 on the walker in under 0.1 s from its own button, or 3.1 s from the page, on its next heartbeat;
  - the page went to "Version 2", "Short sounds", "Applied";
  - a hand in front then gave the short sound and no buzz.
- **Arms:** the exact fixed line, "Answered by the fixed replies".
- **Offline:**
  - the walker was offline 6.5 to 9.9 s after the cut;
  - a Talk press got "I'm offline right now. Your short-sound alerts still work. The obstacle sensor is simulated." at once;
  - the page showed "Offline", every part "Unavailable" and every zone "Unknown" 13.4 to 16.2 s after the cut;
  - after the relay restarted, the walker was online in 6.6 to 7.6 s and said "I'm back online.", and the page showed "Online" in 7.3 to 9.4 s, with the offline lines in the conversation. Those times are set by the walker's 15-second retry: in every run it came back exactly 15 s after its last failed try, and the relay happened to restart 7.4 to 8.4 s into that wait.
- **The page's polite live-region text,** in order, in run 2 (captured from the page; not heard through a screen reader):
  1. "Paired with My walker."
  2. each reply;
  3. "Steady offers: Switch your alerts from buzzing to short sounds. Confirm or decline within a minute."
  4. "Confirmed. Switching your alerts to spoken messages and short sounds."
  5. "Your walker applied the new alerts."
  6. "Your walker went offline."
  7. "Your walker is back online." with the walker's offline lines.

**Timings over all 16 spoken turns:**
- Talk released to the reply's text: 2.1 to 6.3 s, median 3.0 s. Three turns were over 4 s: 4.8, 6.3 and 4.4 s.
- Talk released to the walker's speech file being written: 4.0 to 7.9 s, median 5.3 s; only 1 of 16 was under 4 s. That's the Mac's `say` writing the whole line to a file. The Pi's own voice also writes the whole line before playing it, so this may be closer to when a person would hear it than the text time. Time until speech is heard wasn't measured.
- Talk released to the reply on the page: 2.9 to 6.5 s, median 4.2 s. The page asks for news every 1.5 s.

**Screenshots** at 1440 by 900 of every beat in the first scripted run are in [walker-rehearsal/](walker-rehearsal/).

**Not verified here:**
- the real Pi, its buttons, microphone and speaker, and the hotspot;
- Render;
- Cartesia's voice;
- `--mic mac` and `--loud` with a live voice;
- the ESP32 boards;
- the venue network;
- the projector;
- a VoiceOver pass.
