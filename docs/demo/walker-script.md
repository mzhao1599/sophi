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
- the Pi service, rehearsed as the simulator on a Mac (the results below);
- since the night of 2026-10-24, the real walker hardware so far: a Raspberry Pi 5 running the walker service with a real USB microphone and USB soundbar and one real ESP32 hand board (its Talk button, for now a temporary wire), paired to the server on Render. One real spoken turn ran on it: "What can you help me with?", answered by Gemini about 4 seconds after Talk was let go and heard through the soundbar in Cartesia's voice ([what each Pi step showed](../../devices/pi/README.md#set-up-the-pi));
- the "Your walker" page.

**What is simulated:** in the Mac rehearsal, the whole walker: the simulator stands in for the buttons, microphone and speaker, the hand controls and the obstacle sensors. The page labels every one of them "Simulated", and the whole walker "Simulator". On the real Pi, the obstacle sensors and the other hand are still simulated or missing, and the page labels whatever is simulated.

**What is planned or unverified:**
- the six beats on the real Pi: only the one spoken turn above has run on it; Confirm, obstacles, the alert change, the offline beat and a full run haven't been rehearsed on hardware;
- the ESP32 obstacle board, whose firmware is tested on a computer but hasn't run with the Pi; and a haptic cue sent by the Pi to the hand board;
- Cartesia's voice in a rehearsal: the rehearsal below ran before the key was in, in the walker's own voice. Cartesia's voice has since been heard from the deployed server and on the real Pi's one turn (2026-10-24).

Nothing in this script presents a simulated or planned part as working.

**Labels.** UI text in quotes was seen on screen at 1440 by 900 in the rehearsal on 2026-10-24 (production build of `main` at `37a691c`). Text marked † wasn't seen on screen; check it on the day. The walker's own spoken lines are quoted from the simulator's log.

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

The reply's text reaches the walker 1.9 to 4.6 seconds after you let go, and the walker then speaks it (see the rehearsal results; the time until it's heard isn't measured). Wait for the answer before the next line.

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
6. The page's card says "Confirmed. Switching your alerts to …", and "Alerts" changes to "Version 2", "Short sounds", "Spoken messages", then "Applied" once the walker reports it has applied the change. In the rehearsal that took 0.4 seconds after the walker's Confirm. After the page's Confirm it took about 6 seconds, because the walker only hears of it with its next report (every 5 seconds); "Waiting for the walker" shows meanwhile, so keep talking.
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
   - **Simulator:** press `o` in the simulator's terminal. It cuts the walker's own requests, so the page stays connected.
2. Within about 10 seconds (5.2 to 7.3 seconds in the rehearsal) the walker counts itself offline and says, once: "I'm offline right now. Your short-sound alerts still work."
   - It names the alerts in force now, so after beat 4 it says short sounds.
   - In the simulator it adds "The obstacle sensor is simulated."
   - Measured with the simulator's switch, which fails each request at once. On a hotspot that drops packets, each try can wait out its 5-second deadline first; that isn't measured.
3. Talk (any line): the walker answers at once with the same offline line. It records nothing and doesn't reach the model.
4. The page shows "Offline" with "last seen", every part "Unavailable" and every zone "Unknown" (about 12 to 13 seconds after the cut).
5. Turn the network back on (simulator: press `o` again). Once offline, the walker retries after 10 seconds and then every 15 seconds (and at once when Talk is pressed), so it's back within about 15 seconds of the network returning, plus a hotspot's own rejoin time, which isn't measured. It says "I'm back online." The page shows "Online", and its conversation now holds the offline line once, then "I'm back online.", both marked "On the walker".

> "Buttons and obstacle cues never needed the internet. When it's back, the page catches up with everything the walker said."

## The spoken lines

Only the presenter speaks to the walker: the Gemini key is on the free tier, which is for scripted, made-up lines (see the honesty lines). Judges type on the page instead. Every alternate below ran once in the rehearsal (two extra runs) and gave the same results.

| Beat | Line | Alternates | Must come back |
| --- | --- | --- | --- |
| 2 | "What can you help me with?" | "What are you able to do for me?"; "What can you do?" | A short list of what it can do (obstacles, parts, alerts). Model-written, so the wording changes each time |
| 3 | "Is anything in front of me?" | "Is there something ahead of me right now?"; "How far is the nearest thing?" | The measured distance with its freshness, and in the simulator "These readings are simulated." Never "clear" |
| 4 | "Stop buzzing me, use short sounds instead." | "I'd rather hear beeps than feel the handles shake."; "Can you use sounds instead of vibration?" | Exactly "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." (server-written) |
| 5 | "Can you pick up my keys?" | "Could you grab the glasses I dropped?"; "Can you reach the shelf for me?" | Exactly "This walker doesn't have robot arms, so I can't pick things up or move things." |
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
- **Numbers:** only our own timings, and say they're ours (the rehearsal results below). On the real Pi there is one measured turn so far (about 4 seconds from letting go of Talk to the answer arriving); nothing else on the hardware is measured.
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

**4. What if the internet goes down?** The buttons and obstacle cues keep working on the walker. It says it's offline and answers Talk with a local line built from its current settings. It catches up when the network returns, and the page then shows everything it said. Measured on the simulator, with its own network switch, which fails requests at once: the walker counted itself offline 5.2 to 7.3 seconds after the cut and answered Talk at once. Once offline it retries after 10 seconds and then every 15 seconds, so it's back within about 15 seconds of the network returning (7.1 to 7.6 seconds in the rehearsal, by where the switch fell in that wait).

**5. What if the model is slow or fails?** A turn has 8 seconds on the server. Two Gemini models are asked at once, and the faster backup answers if the main one hasn't within 4.5 seconds (see question 8). If the models fail, or the main one refuses, a fixed answer built from the walker's status is used, and the page marks it "Answered by the fixed replies". If the server's answer doesn't arrive within 10 seconds, the walker gives up, counts itself offline and says its offline line. In the rehearsal no spoken turn needed the fallback, apart from the arms question, whose fixed line is the rule.

**6. Can it move?** No. There is no motion command anywhere in this build. The only thing the walker can make a part do is play one of four fixed haptic patterns, for at most a second.

**7. How fast is it?** These are our timings from the rehearsal below, on a laptop with the simulator: from releasing Talk to the reply's text arriving, 1.9 to 4.6 seconds, with a median of 2.7 seconds, over 16 spoken turns; 2 of them took over 4 seconds. The walker then has to say it: the Pi writes the whole line with its own voice before playing it, so the time until it's heard is longer, and we haven't measured it. The target in our design is 4 seconds to the start of a spoken answer. On the real Pi, one turn so far: 3.96 seconds from letting go of Talk to the answer arriving from Render (2026-10-24); one turn isn't a timing range.

**8. Which models?** Google's Gemini hears the clip and writes the answer in one call. The server asks two Gemini models at once: `gemini-3.7-flash`, whose answer is used when it comes within 4.5 seconds, and the faster `gemini-3.6-flash` as a backup for the rest. In our live tests on 2026-10-23 the backup answered 26 of 210 turns at a 5-second switch-over and 12 of 60 at 4.5 seconds, and every answer it gave that was used was right. The page says "Gemini" for both. Cartesia's text-to-speech (`sonic-3.6`, a stock voice; no one's voice is cloned) speaks it; the server has had a key since 2026-10-24. If Cartesia's audio doesn't come, the walker speaks with its own voice (Piper on the Pi).

**9. Who can see the page?** The browser that paired the walker, through a cookie; there are no accounts yet. A walker is paired with a one-time 6-digit code that lasts 10 minutes. The walker gets its own key, and the server keeps only a hash of it. Five wrong codes lock pairing for 10 minutes.

**10. Does it work without sight or speech?** Every spoken answer also appears on the page. Every offer can be confirmed from the page or the walker's button. The page works by keyboard and announces new replies, walker lines and offers once through a polite live region. It was checked by keyboard alone, at 390 px wide and at 200% zoom, and with reduced motion, in a headless browser against the page's development fake on 2026-10-24. A VoiceOver or NVDA pass is still to do.

**11. What's real hardware here?** On the Mac simulator, none of it, and the page says so on every part. On the real walker: the Raspberry Pi 5 running the walker service, its USB microphone and soundbar, and one ESP32 hand board whose Talk button is, for now, a temporary wire. The obstacle sensors and the other hand are still simulated or not fitted, and the page labels anything simulated. The obstacle board's firmware is tested on a computer but hasn't run with the Pi. Nothing in this build can move: there is no motion command.

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

   **As run in the rehearsal:** these commands as written, except that the database and the walker's state were in a scratch folder, the walker heard recorded clips (`--mic-file`, step 7) instead of the Mac's microphone, and `--out <a scratch folder>` kept its speech files. Run step 7 once with your own voice before judges arrive.
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
     - `o`: the walker's network down, and up again;
     - `q`: quit.
   - **Without speaking:** `--mic-file <a folder of 16 kHz mono WAV clips>` instead of `--mic mac`. Number the clips (`1-ask.wav`, `2-obstacles.wav`, …): each Talk press plays the next one, starting again after the last. That's how the rehearsal ran; making clips is in [devices/pi/README.md](../../devices/pi/README.md#run-it-on-a-mac-simulator).
   - **Not rehearsed:** `--mic mac` and `--loud` with a live voice.
8. **Beat 6 in the simulator.** Press `o` to take the walker's network down and `o` again to bring it back. Turning off the laptop's Wi-Fi doesn't do it: the walker talks to `localhost`.
9. **Screen.** Put the browser and the simulator's terminal side by side; the terminal is the walker's buttons. Click once on an empty part of the page, so the walker's name doesn't keep the focus ring it gets when the page switches to the walker. Close everything else. Do Not Disturb on.
10. **Reset between judges.** On the page, "Forget this walker", then pair again (step 6) and restart the walker (step 7), so each judge sees the same starting state (vibration alerts, version 1).

### B. The real Pi on Max's phone hotspot, server on Render

Needs Max. On the night of 2026-10-24 the Pi steps ran up to one spoken turn: OS, Node, the service, pairing with Render, the USB mic and soundbar, Piper, and one ESP32 hand board for Talk ([what each showed](../../devices/pi/README.md#set-up-the-pi)). Not yet run on the Pi: the GPIO buttons, Confirm, an obstacle board, and the six beats in order.

1. **Render** (Max, once): follow [Deploy on Render](../../apps/web/README.md#deploy-on-render). Paste `GEMINI_API_KEY`, and `CARTESIA_API_KEY` if there is one (or `none`). Check that `/api/v1/health` on the Render address says `{"status":"ok","walker_store":"postgres"}`. If this Mac's network filter blocks `onrender.com`, open the page on a phone or iPad.
2. **The Pi** (Max): follow the Pi checklist in [devices/pi/README.md](../../devices/pi/README.md#set-up-the-pi):
   - OS and Node 22;
   - Talk on GPIO17 and Confirm on GPIO27, declared with `WALKER_GPIO_BUTTONS=wired`;
   - a USB microphone and speaker;
   - the systemd service.

   Each step there says what to check.
3. **Network:** the Pi joins Max's phone hotspot, and the laptop stays on venue Wi-Fi. That way, turning off the hotspot (beat 6) takes only the walker offline.
4. **Pair:** open `/walker` on the Render address, press "Get a pairing code", and on the Pi run the pair command from the Pi checklist with `--server https://<the Render address>`. The page switches to the walker. On a sleeping free server the first request can take a minute: the Pi wakes it before using the code.
5. **Obstacle sensors and hand boards:** one hand board (`hand-left-01`) ran with the Pi and gave Talk on a temporary wire before the side mapping changed. Current Pi code treats that left control as Confirm; Talk is on `hand-right-01` or a wired Pi GPIO Talk button. The new mapping still needs a physical check. The obstacle board hasn't run. If no sensor board is connected, the page shows "No obstacle sensors reporting." In that case skip beat 3, and in beat 4 say the cue change is saved for when the sensors are fitted.
6. **Cartesia,** only with a key: the page says "In Cartesia's voice"† under spoken replies. Its terms (read 2026-10-24) allow training on inputs unless agreed otherwise, so the same scripted-lines-only rule as Gemini's free tier applies.
7. **Run it once** on the venue network: all six beats, including the hotspot off and on. Time beat 6's return on the real hotspot; it isn't measured.
8. **Card on the walker:** "Only the presenter speaks to this walker. Type on the page instead; it says where typed words go."

## Requests

**Fixed since the first rehearsal** (on `main` at `37a691c`, and checked in this rehearsal):
- #45, the Pi: `--mic-file` takes a folder or list and re-reads each clip at its press; `o` and `g` take the simulator offline against a real server; "Applied" comes within about half a second of the walker's Confirm; the offline line reaches the page once.
- #44, the server: "All of this walker's parts are simulated." when every reported part is.
- #43, the contract: `answered_by` is `fixed` whenever a fixed reply replaced the model's, as the server does.

**Found in this rehearsal,** each with an owner:
1. **Server: an age in milliseconds, read aloud. Fixed** (branch `claude/walker-turn-wording`). One of five obstacle answers said "…at 30 centimetres from 44 milliseconds ago." The others said "just now", "right now" or "less than a second ago". The model was shown each reading's age in milliseconds. Now it's shown the age already worded as it should be said (`reading_age`: "just now" under a second, then whole seconds such as "3 seconds ago"). Measured live on Gemini, typed "Is anything in front of me?" on an all-simulated walker: before, 1 of 5 answers said milliseconds (44 ms readings); after, 0 of 5 at 44 ms, all saying "just now", and 0 of 3 at 3.2 s, all saying "3 seconds ago".
2. **Server: the simulated line repeated the model. Fixed** (same branch). All four "which parts…" answers already said every part is simulated before the server added "All of this walker's parts are simulated." The rule is structured and can't see the words. Now the policy tells the model the server adds that line itself (when every part is simulated and the question isn't about obstacles), so it leaves it out; the server's rule is unchanged and still the guarantee. Measured live on Gemini, typed "Which of your parts are simulated?", "Are any of your parts not real hardware?" and "Which parts of my walker are working right now?": before, 5 of 5 answers said every part is simulated before the server's line; after, 0 of 5, each naming the parts and their health ("…are healthy.") followed by the server's line.
3. **Page: two announcements in the wrong order.** Now that "Applied" comes within half a second, it lands in the same poll as the offer's closing, and the live region reads "Your walker applied the new alerts. Confirmed. Switching your alerts to …". Smallest fix: in `useWalkerPage.ts`'s `applyList`, put the offer's closing line before the walker's other news. Owner: the page (this script's author). **Fixed** on branch `claude/walker-page-announce-order`: `applyList` now reads any connection line first, then the offer's closing, then the walker's news (`readingOrder` in `walkerView.ts`), so it reads "Confirmed. Switching your alerts to … Your walker applied the new alerts." Not yet re-rehearsed with the simulator.
4. **Page Confirm, by design:** after the page's Confirm, "Applied" took about 6 seconds, because the walker hears of it with its next report (every 5 seconds). The script says to keep talking; no change needed.

## Rehearsal results

**Date:** 2026-10-24, 05:31 to 05:39 PDT (five runs; times from the simulator's logs). **Code:** `main` at `37a691c`, as merged, with no patches: the server (#31, #39, #44), the page (#34), the Pi service (#36, #45) and the contract (#43). **Setup:**
- a production build of `apps/web` on port 3009, with a throwaway Postgres 17 (Homebrew) on port 55433 as `DATABASE_URL`;
- Max's Gemini key from `apps/web/.env.local`, and no Cartesia key, so every spoken reply was offered "In the walker's own voice";
- the walker simulator, bundled from `37a691c`, paired from the page each run, talking to the server directly, with beat 6 cut by its own `o` key;
- a headless Chromium at 1440 by 900 driving the page by keyboard;
- a terminal driver pressing the simulator's keys, holding Talk for 1.5 s from "mic open".

**The spoken lines were synthetic.** macOS `say` read each line into a 16 kHz mono WAV, and each run passed a folder of them with `--mic-file`. Nothing played aloud. Times come from the simulator's log (millisecond timestamps), the speech files' write times, and the page.

**Results.** Five runs, and every one passed every beat:
- three with the scripted lines and the walker's Confirm;
- one with the first alternates and the page's Confirm;
- one with the second alternates and the walker's Confirm.

| Run | 1. Boot | 2. Ask | 3. Obstacles | 4. Setting | 5. Arms | 6. Offline | Typed on the page |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Scripted 1 | pass | pass, 2.4 s | pass, 3.7 s | pass, 2.2 s, Applied 0.4 s | pass, 4.5 s | pass | 2.1 s |
| Scripted 2 | pass | pass, 1.9 s | pass, 3.4 s | pass, 2.4 s, Applied 0.4 s | pass, 2.4 s | pass | 2.0 s |
| Scripted 3 | pass | pass, 2.5 s | pass, 2.7 s | pass, 4.6 s, Applied 0.4 s | pass, 3.1 s | pass | 1.9 s |
| Alternates 1 (page Confirm) | pass | pass, 3.3 s | pass, 2.7 s | pass, 2.4 s, Applied 6.1 s | pass, 3.0 s | pass | 1.8 s |
| Alternates 2 | pass | pass, 4.0 s | pass, 3.3 s | pass, 3.1 s, Applied 0.4 s | pass, 3.4 s | pass | 1.6 s |

Spoken beats give the time from releasing Talk to the reply's text arriving on the walker. "Applied" is from Confirm to the page showing "Applied". "Typed" is from Enter to the reply on the page.

**What each beat checked, every run:**
- **Boot:** "Steady is on." 0.1 to 0.2 s after start; the page "Online" in about 1.5 s; every part "Healthy" and "Simulated", including "Walker and coordinator"; alerts "Version 1", "Applied".
- **Ask:** "You said (as heard by Gemini)" with the exact words, answered by the model, "In the walker's own voice".
- **Obstacles:**
  - the handle buzz within 0.1 s of the hand;
  - when the page was read 6.5 s after the hand, it showed "Front left 30 cm" "Simulated", measured 2.9 to 4.5 s earlier;
  - the answer gave 30 cm and 1.5 m and "These readings are simulated."; never "clear".
- **Setting:**
  - the exact server line and the offer card;
  - Confirm gave configuration version 2 on the walker within 0.1 s from its own button, or 4.6 s from the page, at its next report;
  - the page went to "Version 2", "Short sounds", "Applied", showing "Waiting for the walker" first in the page-Confirm run;
  - a hand in front then gave the short sound and no buzz.
- **Arms:** the exact fixed line, "Answered by the fixed replies".
- **Offline:**
  - the walker was offline 5.2 to 7.3 s after `o`;
  - a Talk press got "I'm offline right now. Your short-sound alerts still work. The obstacle sensor is simulated." at once;
  - the page showed "Offline", every part "Unavailable" and every zone "Unknown" 11.6 to 13.4 s after the cut;
  - after `o` again, the walker was online in 7.1 to 7.6 s and said "I'm back online."; the page showed "Online" in 7.4 to 9.0 s, with the offline line once and "I'm back online." in the conversation.
- **The page's polite live-region text,** in order, in run 2 (captured from the page; not heard through a screen reader):
  1. "Paired with My walker."
  2. each reply;
  3. "Steady offers: Switch your alerts from buzzing to short sounds. Confirm or decline within a minute.";
  4. "Your walker applied the new alerts. Confirmed. Switching your alerts to spoken messages and short sounds." (in the wrong order: request 3);
  5. "Your walker went offline.";
  6. "Your walker is back online." with the walker's offline line;
  7. "On the walker: I'm back online."

**Timings over the 16 spoken turns of the first four runs** (the second-alternates run, 3.1 to 4.0 s, is in the table):
- Talk released to the reply's text: 1.9 to 4.6 s, median 2.7 s. Two turns were over 4 s: 4.5 and 4.6 s.
- Talk released to the walker's speech file being written: 3.8 to 6.9 s, median 5.0 s; 3 of 16 were under 4 s. That's the Mac's `say` writing the whole line to a file. The Pi's own voice also writes the whole line before playing it, so this may be closer to when a person would hear it than the text time. Time until speech is heard wasn't measured.
- Talk released to the reply on the page: 2.3 to 5.4 s, median 3.5 s. The page asks for news every 1.5 s.

The first rehearsal, on `beab832` before #43 to #45, used a patched simulator bundle and a relay for beat 6; its results are in this file's history.

**Screenshots** at 1440 by 900 of every beat in the second scripted run are in [walker-rehearsal/](walker-rehearsal/).

**Not verified here:**
- the real Pi, its buttons, microphone and speaker, and the hotspot;
- Render;
- Cartesia's voice;
- `--mic mac` and `--loud` with a live voice;
- the ESP32 boards;
- the venue network;
- the projector;
- a VoiceOver pass.
