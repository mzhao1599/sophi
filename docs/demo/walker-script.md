# Sophi on the walker: live demo script

**Sophi. A physical augmentation walker.** You set it up by talking to it, and you can talk to it every day after.

This is the script for showing the always-on walker assistant to judges at Cal Hacks (October 23 to 25, 2026). It has:
- a click and speak sequence for the six beats, with the presenter's exact spoken lines and fresh-wording alternates, plus two later segments: the two phones, and the arms (with the lift, once it's ready);
- what the "Your walker" page and the walker's own 5-inch screen show at each beat;
- the honesty lines and judge Q&A;
- a 60-second cut, and how this joins the onboarding demo in one 3 to 4 minute run;
- a setup checklist for two cases: the simulator on the Mac, and the real Pi on the venue network (Ethernet) with the server on Render;
- a rehearsal checklist, three runs in a row for each segment, and the earlier rehearsal results, with timings.

The onboarding demo's script is [script.md](script.md); it stays the source for Wren's lines and the website setup. Sponsor-track framing is in [tracks.md](tracks.md).

**What is real today** (2026-10-24):
- the walker assistant's server on Render, with pairing, heartbeats, the assistant turn on Google's Gemini (a main model and a faster backup), offers and Confirm, on Postgres. Since 2026-10-24 the server, not the model, writes the spoken answer to an obstacle question, from the readings the walker sent;
- the "Your walker" page, with its "Behind the scenes" panel and, since 2026-10-24, a "Phones" card;
- the Pi service, rehearsed as the simulator on a Mac on 2026-10-23 (the results below, from before the screen, the phones, the arms and the server-written obstacle answer);
- the real walker so far:
  - a Raspberry Pi 5 running the walker service with a real USB microphone and USB soundbar. On 2026-10-23 one real spoken turn ran on it: "What can you help me with?", answered by Gemini about 4 seconds after Talk was let go and heard through the soundbar in Cartesia's voice ([what each Pi step showed](../../devices/pi/README.md#set-up-the-pi));
  - on 2026-10-24: the Pi ran from the walker's battery through its 5 V converter (power draw not measured; the Pi reset when a third USB hub, or the GPS straight into the Pi, was plugged in, cause not found). Both hand boards (`hand-right-01`, `hand-left-01`) said hello and were healthy, "Sophi is on." played, Talk on the right handle gave two answered turns, and the left handle gave the Confirm press cue. Pressing Confirm to answer an offer hasn't been tried on the Pi. After a full power cycle the handles' USB ports took about six minutes to open ([hardware record](../../hardware/current-build.md));
  - the paired Pi asked the server for Cartesia's voice for its own lines and got audio back (2026-10-24); nobody has listened to it yet.

**What is simulated:** in the Mac rehearsal, the whole walker: the simulator stands in for the buttons, microphone and speaker, the hand controls and the obstacle sensors. The page labels every one of them "Simulated", and the whole walker "Simulator". On the real Pi, the obstacle sensors are still simulated or missing, and the page labels whatever is simulated.

**Built during the event, not yet run on the real walker:**
- the walker's 5-inch screen: run only in the simulator under headless Chromium at 800 by 480. The kiosk that shows it full screen hasn't been installed on the Pi, and nothing has been seen on the panel;
- the two-phone app at `/app` and the Phones card: live on Render, tested in a headless browser against the real routes, three runs in a row, before the opt-in GPS sharing was added. Not yet on real iPhones;
- the arms: the Pi's motion coordinator for the two SO-101 arms, copy mode (teleop), taught skills and "Let go?", tested only against simulated servos. No arm has been calibrated, and the demo's tray task (`tray_pick_handover`) hasn't been taught;
- the lift: its firmware is tested on a computer. Since 2026-10-24 the Pi's lift client is wired into the motion coordinator, tested only against a simulated lift board and simulated servos: a lift target is prepared at the terminal, and starts only on a handle Confirm press while someone holds the screen's hold control and both arms are folded. It has never talked to the real lift board, driver, motor or switches, and it can't move without the hardware stop, so it can't move on the walker today;
- the hardware stop: chosen in the contract (a latching switch that cuts the arms' 12 V and the lift's step signal), but no switch is bought or wired;
- `walker check`, the one read-only check of the whole walker: tested only with fakes on a Mac;
- the USB GPS: it sent valid data on the Pi but had no fix indoors. Speaking a location or the weather hasn't been checked on the Pi.

**Still to do on the real walker:** the six beats in order, Confirm on an offer, an obstacle board, the offline beat with the Ethernet cable, the screen on the panel, the phones on real iPhones, and every arm and lift step.

Nothing in this script presents a simulated or planned part as working.

**Labels.**
- Quoted page text without a mark was seen on the "Your walker" page at 1440 by 900 in the rehearsal on 2026-10-23 (production build of `main` at `37a691c`). It's the same web page whichever walker feeds it.
- **†** marks anything not yet seen or heard with the real hardware it depends on (the Pi and its boards, an obstacle board, the 5-inch panel, real phones, the arms or the lift), and page text not yet seen in any run. That includes lines seen only in the simulator, only in a headless browser, or read from the code. Check each one on the day, and take a mark off only with the date and what was seen.
- The walker's own spoken lines are quoted from the simulator's log or from the code.

## The demo at a glance

| Beat | Presenter does | The walker says or does | The page | The walker's screen † |
| --- | --- | --- | --- | --- |
| 1. Boot | Starts the walker | "Sophi is on." | Online, each part with its health and "Simulated", the "Simulator" badge, alerts "Applied" | The clock and the alerts in force; "Online" in the strip |
| 2. Ask | Holds Talk: "What can you help me with?" | Answers out loud | "You said (as heard by Gemini)", the reply, "In the walker's own voice" | "Listening", "One moment", then the reply as captions, "Answered by Gemini" |
| 3. Obstacles | Hand in front of the sensor, then asks "Is anything in front of me?" | Buzzes the handle at once (local) †, then reads the distances, written by the server, with "These readings are simulated." † | Front left about 30 cm, "Simulated"; the reply "Answered by the fixed replies" † | "Something close", "Front left · 30 cm", "Simulated"; then the captions |
| 4. Change a setting | Asks "Stop buzzing me, use short sounds instead.", then presses Confirm | "I can switch your alerts from buzzing to short sounds. Press Confirm to do it.", then "Done. Obstacle alerts now use short sounds." † A hand in front now gives the short sound, no buzz † | The offer card, then "Version 2", "Short sounds", "Applied" | "Short sounds?", "Confirm" over the left handle, then "Done" |
| 5. Arms (only with no arms fitted) | Asks "Can you pick up my keys?" | "This walker doesn't have robot arms, so I can't pick things up or move things." † | The same line, "Answered by the fixed replies" | The captions, "Answered by the fixed replies" |
| 6. Offline | Unplugs the Pi's Ethernet cable | A Talk press gets "I'm offline right now. Your short-sound alerts still work." at once † | "Offline", every part "Unavailable", every zone "Unknown"; it comes back when the network does | "No internet", "Alerts still work on the walker." |
| 7. Two phones † | Adds Maya's phone, approves her with the consent line, she sends a message | Nothing: the walker isn't part of this | The Phones card: a code, Maya waiting, the consent line, Approve | Nothing: the screen has no messages yet |
| 8. Arms † (only if rehearsed 3 of 3 that day) | A Confirm press runs the taught tray task, a second answers "Let go?", then copy mode, stopped by a handle press | Says each Confirm target aloud; the arm picks from the tray and holds it out | Nothing about the arms | The target and "Confirm" over the left handle; what moves and "Stop" over both handles; "Done" |
| 8 with the lift † (only if the lift passed 3 of 3 that day) | Holds the screen's hold control and presses Confirm: home, raise to the tray, the tray task, "Let go?", lower | Says each lift target aloud ("Raise the lift to … mm."); the carriage moves only while held | Nothing about the lift | "Hold to raise" with "and press Confirm"; "Keep holding"; "Stopping" after a release |

The lift needs the hardware stop wired, so it stays out of the run until that's done: see [The lift, inside segment 8](#the-lift-inside-segment-8).

## Click and speak sequence

Every action and line, in order. Before judges arrive, the walker is paired and on, and the page is open at `/walker` with the walker showing "Online" (see the setup checklist). The whole run, beats 1 to 6 and both segments, takes about 4 minutes 40 seconds.

**Talk and Confirm, on each setup.**
- **Real Pi:** hold the Talk button on the **right** handle while you speak, then let go. Confirm is on the **left** handle.
- **Simulator:** press `t` in the simulator's terminal, speak, then press `t` again to send. A terminal can't see a key being released, so the simulator's Talk toggles. `c` is Confirm.

The reply's text reaches the walker 1.9 to 4.6 seconds after you let go on the simulator, and the walker then speaks it (see the rehearsal results; the time until it's heard isn't measured). On the real Pi, one timed turn took 3.96 seconds. Wait for the answer before the next line.

**The walker's screen.** Each beat says what the 5-inch screen shows. All of it was seen only in the simulator under headless Chromium at 800 by 480 (†); it hasn't been seen on the panel. If the panel isn't working, see [Fallbacks](#fallbacks). The screen always shows an obstacle first, above everything else, then any arm motion or arm fault, then her own Talk turn, then the rest.

### Beat 1. Boot (0:00 to 0:15)

> "This is Sophi on the walker. It runs whenever the walker is on, and nothing listens until I hold Talk."

1. Start the walker. The Pi starts on its own at power-on; for the simulator, start it with the command in the setup checklist. On the real Pi, power it on at least 10 minutes before judges arrive: after a full power cycle the handles took about six minutes to connect.
2. The walker says "Sophi is on."
3. Within about 2 seconds the page shows:
   - "Online";
   - the drawing with each part and its health: Hand controls, Obstacle sensors, Voice, Walker and coordinator, each "Healthy";
   - in the simulator, every part also says "Simulated", and the "Simulator" badge shows with "This walker is the simulator running on a computer, not a Pi.";
   - "Alerts": "Vibration in the handles", "Spoken messages", "Applied".
4. The obstacle readings appear about 5 seconds after boot ("No obstacle sensors reporting." until the first reading arrives).
5. **The screen** †: the clock, with the time once the Pi's clock has synced ("Sophi" before that), the day and the alerts in force ("Alerts: buzz and speech"). The strip says "Online", and "Simulator" on the simulator.

### Beat 2. Ask (0:15 to 0:35)

> "I'll ask it what it can do."

1. Talk: **"What can you help me with?"**
2. The walker answers out loud. Rehearsed answers, in the model's own words, for example: "I can check obstacle readings, report on your walker's parts, or change how you receive alerts."
3. Point at the page:
   - "You said (as heard by Gemini)" and your words;
   - the reply;
   - "In the walker's own voice" under it, or "In Cartesia's voice"† when the server has a Cartesia key (it has had one on Render since 2026-10-23).
4. **The screen** †: "Listening" and "Let go of Talk when you're done." while Talk is held; "One moment" and "Your question is with Sophi." until the answer comes (nothing on it moves); then the reply as captions, paged at sentence ends ("1 of 2"), with "You said: …" and "Answered by Gemini".

> "Gemini heard that and wrote the answer. The page and the walker's screen both show it, so voice is never the only way to follow it."

### Beat 3. Obstacles (0:35 to 1:00)

> "The obstacle cue is local: no internet, no model."

1. Put a hand in front of the sensor. In the simulator, press `n` (a hand at 30 cm, front left).
2. The handle buzzes at once †. In the rehearsal the buzz went out within 0.1 s of the hand; the simulator logs "SIMULATED handle buzz".
3. **The screen** †: "Something close", "Front left · 30 cm" and a "Simulated" tag. This screen comes before everything else, as long as the hand is there and for 1 second after.
4. Within a few seconds (the walker reports every 5 seconds) the page's "Obstacles" shows "Front left 30 cm", "Simulated".
5. Talk: **"Is anything in front of me?"** Let go, then take your hand away (simulator: `f`). The answer reads the readings the walker sent when you let go, and taking the hand away lets the screen show the captions.
6. The walker answers with the server's own line, built from those readings †. In the simulator, which has two zones:

   "The obstacle sensors read front left: 30 centimetres, just now; front right: 150 centimetres, just now. These readings are simulated."

   - Gemini only decides that this is a question about the sensors. The numbers, the zones and "just now" are written by the server from the walker's readings, never by the model.
   - A zone without a fresh, valid reading is read out as "no current reading", never as clear. With no readings at all it says "I don't have any obstacle sensor readings right now."
   - "These readings are simulated." comes when every reading is from a simulated sensor; "Some readings are simulated." when only some are.
   - The age is "just now" under a second, then whole seconds ("3 seconds ago").
7. The page shows the reply with "Answered by the fixed replies" under it †, and the screen's captions say the same †.

> "Sophi chose to read the sensors, but the numbers come from the walker, word for word. A missing or old reading is 'no current reading', never clear. And here every reading is from the simulator, and it says so."

The page's distance comes from the walker's report every 5 seconds, so it can read "measured 3.0 s ago", and after the hand is gone it shows 150 cm again; the spoken answer uses the reading the walker had when you let go of Talk ("just now"). Both are true.

### Beat 4. Change a setting (1:00 to 1:35)

> "The buzz is too much. I'll ask for something else."

1. Talk: **"Stop buzzing me, use short sounds instead."**
2. The walker says: "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." † This line is written by the server from the change itself, never by the model.
3. The page shows the offer card:
   - "Sophi offers";
   - "Switch your alerts from buzzing to short sounds.";
   - "Now", "After";
   - "Confirm" and "Decline";
   - "Expires in 0:5x";
   - "Or press Confirm on the walker."
4. **The screen** †: "Short sounds?", the alerts it would give ("Alerts: speech and short sounds", in the offer's order), "Offered by Sophi", "About a minute", and "Confirm" over the left handle. There is nothing to tap: the handle's Confirm answers it.
5. Press Confirm on the walker (left handle; simulator: `c`) †, or Confirm on the page.
6. The walker says "Done. Obstacle alerts now use short sounds." †
7. The page's card says "Confirmed. Switching your alerts to …", and "Alerts" changes to "Version 2", "Short sounds", "Spoken messages", then "Applied" once the walker reports it has applied the change. In the rehearsal that took 0.4 seconds after the walker's Confirm. After the page's Confirm it took about 6 seconds, because the walker only hears of it with its next report (every 5 seconds); "Waiting for the walker" shows meanwhile, so keep talking.
8. **The screen** †: "Done" and the new alerts ("Alerts: speech and short sounds.") for 4 seconds, only once the new alerts are in force on the walker; then the clock with the new alerts.
9. Hand in front again (simulator: `n`, then `f`): now a short sound, no buzz †.

> "The model can only offer. Nothing changed until I pressed Confirm, and the page only says 'Applied' when the walker itself reports it."

### Beat 5. Arms (1:35 to 1:50)

**Only on a walker with no arms fitted** (the simulator, or the walker before the arms go on). The server's line comes from what the walker reports, and today the Pi never reports its arms (`MANIFEST_MAY_LIST_ARMS = false` in [`motion.ts`](../../packages/contracts/src/motion.ts)). So on a walker with arms on it the line below would be untrue: **skip beat 5 whenever arms are fitted**, and go from beat 4 to beat 6.

1. Talk: **"Can you pick up my keys?"**
2. The walker says: "This walker doesn't have robot arms, so I can't pick things up or move things." †
3. The page marks it "Answered by the fixed replies": when the model marks a question as about the arms (a structured field, not word matching), the server replaces the reply with a fixed line built from what the walker reports. The screen's captions say the same †.

> "There are no arms on this walker, and the conversation can't move anything. It says so instead of pretending."

**Alternative, only after the arms pass 3 of 3 on the real walker** (not built). Two code changes first: the Pi must list the arms (`manipulation.arm`) in what it reports, which nothing does today, and `MANIFEST_MAY_LIST_ARMS` must be set to true. A contract test then fails until the no-arms line above is taken out of this file. Then:

1. Talk: **"Can you pick up my keys?"**
2. The walker says: "I can't move the robot arms from a conversation yet." †

> "The arms are real, but a conversation can't start them. Only a Confirm press at the walker can, and I'll show you that next." †

### Beat 6. Offline (1:50 to 2:30)

> "Now it loses the internet."

1. Cut the walker's network:
   - **Real Pi:** unplug the Ethernet cable at the Pi's end. Never unplug anything at the venue's switch. The laptop stays on its own connection, so the page keeps working. This takes the walker offline only if it has no Wi-Fi to fall back to: keep its Wi-Fi backup off ([setup B, step 3](#b-the-real-pi-on-the-venue-network-server-on-render)).
   - **Simulator:** press `o` in the simulator's terminal. It cuts the walker's own requests, so the page stays connected.
2. Within about 10 seconds (5.2 to 7.3 seconds in the rehearsal) the walker counts itself offline and says, once: "I'm offline right now. Your short-sound alerts still work." †
   - It names the alerts in force now, so after beat 4 it says short sounds.
   - In the simulator it adds "The obstacle sensor is simulated."
   - Measured with the simulator's switch, which fails each request at once. Unplugging the Pi's cable hasn't been timed: how soon the Pi notices, and whether each try then fails at once or waits out its 5-second deadline first, isn't measured. On 2026-10-23, when the Pi changed Wi-Fi networks, it logged "I'm offline right now." and "I'm back online." about 10 seconds apart; no speaker was plugged in.
3. **The screen** †: "No internet" and "Alerts still work on the walker.", with "Offline" in the strip.
4. Talk (any line): the walker answers at once with the same offline line †. It records nothing and doesn't reach the model. The screen shows it as captions with "On the walker, offline reply" †.
5. The page shows "Offline" with "last seen", every part "Unavailable" and every zone "Unknown" (about 12 to 13 seconds after the cut).
6. Turn the network back on (real Pi: plug the cable back into the Pi; simulator: press `o` again). Once offline, the walker retries after 10 seconds and then every 15 seconds (and at once when Talk is pressed), so it's back within about 15 seconds of the network returning, plus the Pi's time to get its wired address back, which isn't measured. It says "I'm back online." † The page shows "Online", and its conversation now holds the offline line once, then "I'm back online.", both marked "On the walker". The screen goes back to the clock, "Online" in the strip †.

> "Buttons and obstacle cues never needed the internet. When it's back, the page catches up with everything the walker said."

### Segment 7. Two phones (2:30 to 3:30) †

The care loop: the person who walks with the walker (Rose) and her caretaker (Maya), each on a phone. Both names are made up. Everything here is † until it has run on two real phones against Render three times in a row; so far it ran in a headless browser on a local server, before the opt-in GPS sharing was added. It works the same with the simulator or the real Pi.

**Who holds what.**
- **The presenter** stands at the walker, holds Rose's phone, and works the laptop with the "Your walker" page (the family's page, on the projector).
- **A teammate** plays Maya and holds Maya's phone.
- Both phones are on **cellular**, never a hotspot (Cal Hacks bans them) and not the venue Wi-Fi: phones behind one address share the wrong-code lockout. Each has `/app` on Render open, added to its Home Screen as "Sophi" (not yet tried on an iPhone).

**Before judges arrive:** on the page's Phones card, "Add a phone", "The walker user's own phone", name "Rose", "Get a code". Type the code on Rose's phone ("Link this phone to a walker", "Link this phone"). Her phone is in at once, with four big tiles: Get help, My walker, Message Maya, People nearby. A code works once, for 10 minutes.

> "Sophi isn't only for the person on the walker. This is Rose's phone, three big buttons and no typing, and this is Maya's, her caretaker."

1. On the page's Phones card: "Add a phone", "A caretaker's phone", name "Maya", "Get a code". The card shows "Code for Maya (caretaker)" and six digits.
2. Maya types the code on her phone and presses "Link this phone". Her phone says "Waiting for the family to approve". A waiting phone lapses after 5 minutes.
3. The Phones card shows Maya waiting, with a box to tick: "Rose agreed that Maya can see whether the walker is on, its part health and alerts, exchange short messages with her, and see a recent GPS position only if location sharing is turned on later." Tick it, then "Approve Maya". Approve does nothing until the box is ticked.

   > "Maya gets in only after the family ticks what Rose agreed to."

4. Maya's phone opens on "Rose's walker": Online or Offline, a "Simulator" tag on the simulator, the alerts in force, each part's health, "Walker's location" with "Location sharing is off.", and "Battery: not measured on this walker".
5. Maya opens Messages, types **"Dinner at six. I'll get you."** (28 characters; a message is at most 30) and sends it.
6. Rose's "Message Maya" tile shows "1 new message". She taps it, then taps the message: her phone reads it aloud in the phone's own voice, and only when she taps. That isn't Sophi's voice and doesn't go through Sophi's server.
7. Rose taps **"I'm okay"**. Her phone says "Sent to Maya: I'm okay", and it appears in Maya's thread.
8. Rose opens "People nearby": a dashed "Sample" tag and "Sample people for the demo. This list does not use GPS or anyone's real location."

> "Maya sees whether the walker is on and how its alerts work, never what Rose says to Sophi. Messages are deleted after a day. And the people nearby are sample data, and the screen says so."

**Get help (about 40 s)** †. Rehearsed 3 of 3 on a Mac with the simulator, a local server and live Gemini, phones in a headless browser ([results](../subsystems/help.md#rehearsal-results-2026-10-24-on-a-mac-not-the-real-walker-or-phones)); not yet on the real Pi, real phones or Render. Maya's phone must have Sophi open: there are no push notifications.

9. Hold Talk: **"I've fallen. Please get Maya."** The walker: "I'll ask Maya for help in 8 seconds. Press any button to stop." Its screen counts down from 8.
10. At zero: "Asking for help.", then "Sent to Maya's phone." Maya holds up her phone: "Rose asked for help", "By asking Sophi, just now." (under 0.2 s after the walker asked, in rehearsal). The walker: "It's showing on Maya's phone."
11. Maya taps **"I'm on my way"**. The walker: "Maya is on the way." (0.5 to 2 s later), and Rose's phone says so too.
12. Press **Confirm twice**. The walker: "Press Confirm again to tell Maya you're okay.", then "Okay. Maya will see that you're okay." Maya's phone: "Rose says she's okay."

> "Rose can ask for help three ways: by voice, by holding both handles for two seconds, or with one big button on her phone. The model only starts a countdown she can stop; the walker sends the request itself. Sophi doesn't call 911: it tells her caretaker, and both phones have a Call 911 link."

**If the voice turn is slow or fails:** hold Talk and Confirm together for 2 s (on the simulator, press `h`); the same beat follows from "Asking for help." **Never** tap "Call 911" on stage: it opens the phone's dialer.

**Don't say:** that Sophi detects falls (the walker has no motion sensor), calls 911 or anyone, or reaches a phone whose app is closed.

**Location sharing: Max decides; leave it out by default.** Rose's "My walker" screen has "Share my location with approved caretakers". It starts off, and only her own phone can turn it on. Turned on, the walker sends its latest GPS position to Sophi's server with each report, and Maya's phone shows it under "Walker's location", with a link that opens it in OpenStreetMap (which then gets the position). Separately, asking the walker "Where am I?" or "What's the weather near me?" sends one position to outside services: OpenStreetMap's address lookup (Nominatim) or Open-Meteo. Why leave it out: the GPS had no fix indoors on 2026-10-24, none of this has been checked on the Pi, and it sends a real position off the walker. If it's in, say the location honesty line below.

### Segment 8. The arms (3:30 to 4:40) †

**Not yet run on the real arms.** Every line here is † until the arms have been calibrated, the tray task taught, and this segment rehearsed 3 of 3 on the real walker that day ([bench bring-up](../../devices/pi/README.md#bench-bring-up-with-real-arms-2026-10-25-plan-nothing-below-has-been-done-yet), [teaching the tray task](../../devices/pi/README.md#teach-the-tray-task-tray_pick_handover-after-the-bench-bring-up-2026-10-25-plan-not-done-yet)). **Skip it** unless it passed 3 of 3 that day.

**The rule on stage** ([the motion rule](../../docs/subsystems/manipulation.md#the-rule)): motors start only when a person at the walker presses Confirm on a handle; any handle press stops what moves; the conversation, the phones and the website can't start anything.

**Who is where.**
- **The presenter** at the walker presses the handle buttons and takes the object from the arm.
- **A teammate at the Pi's terminal** prepares each step (`walker arms ...`) and keeps a hand on the arms' 12 V switch until the hardware stop is wired. A prepared step only becomes the walker's one pending Confirm target; it never starts by itself. The terminal needs a way into the Pi at the venue, which may block SSH from the laptop (see setup B).
- **The same or a second teammate** moves the teaching (leader) arm in copy mode.
- **Judges stay outside the arms' reach** (behind tape on the floor). Until the hardware stop has passed three times in a row, nobody but these teammates is within reach, and the object is handed to the presenter, never to a judge.

**Before the segment:** the left arm's motors on (`arms torque on --arm left`, then Confirm) and the arm at `ready` (`arms pose go ready --arm left`, then Confirm), with the object on its taped spot on the tray. Don't press Talk during the segment: it withdraws a pending target, and it stops anything moving.

**Which safety line to say** depends on the stop:
- **Hardware stop wired and passed 3 of 3:** "And this red switch cuts the arms' power, whatever the software is doing." †
- **No hardware stop yet** (today): the Pi must run in bench mode (`WALKER_MOTION_BENCH=no-hardware-stop`), at lower speeds and torque, and every motion screen says "Bench mode: no hardware stop". Say: "There's no hardware stop wired yet, so it runs in bench mode, slower, and the screen says so. My teammate has a hand on the arms' power." †

> "These arms move only when someone at the walker presses Confirm. Not the model, not the phone, not the website." †

**The taught task** (`tray_pick_handover`: pick a light object from a fixed tray and hold it out):

1. The teammate runs `walker arms skill run tray_pick_handover`.
2. The walker says the task's own title and the park line, for example "Hand you the cup. Park the walker and lock the brakes, then press Confirm." (the title is whatever was set when it was taught) †.
3. **The screen** †: the task's title ("Hand you the cup"), "Park the walker and lock the brakes, then press Confirm.", and "Confirm" over the left handle. There is nothing to tap.

   > "It's waiting for me. Parked is my confirmation; there's no brake sensor." †

4. Wait 2 seconds, then press Confirm on the left handle. A press in the first 2 seconds is ignored, and so is one if the button wasn't released for the 2 seconds before it.
5. The arm picks the object from the tray and holds it out †. **The screen** †: the title, "Press any handle button to stop.", and "Stop" over both handles.
6. It ends holding. The walker says "Let go? Park the walker and lock the brakes, then press Confirm." † and the screen shows "Let go?" with "Confirm" over the left handle †.
7. Take hold of the object, wait 2 seconds, press Confirm. Only the gripper opens, slowly †. The screen says "Letting go", then "Done" and "Holding still." †

> "It never lets go until the person holding it says so. And letting go always works, even after a fault." †

**Copy mode** (teleop: the walker's arm copies the teaching arm):

8. The teammate runs `walker arms teleop left`. The walker says "The left arm will copy its teaching arm. Park the walker and lock the brakes, then press Confirm." †
9. Wait 2 seconds, press Confirm. The second teammate moves the teaching arm, and the walker's arm follows it, at most 45 degrees a second in bench mode †. **The screen** †: "Teaching mode", "Press any handle button to stop.", "Stop" over both handles.
10. Press any handle button. The arm stops at once and holds where it is †. The screen says "Stopped" and "Holding still." †

> "Any button on either handle stops it. That's how a skill like the tray task is taught: someone moves the teaching arm once, and Sophi replays it only when Confirm is pressed." †

### The lift, inside segment 8

**Not yet run on the real lift: every line here is †.** The lift's code is built and wired into the Pi's motion coordinator, and has run only against a simulated lift board and simulated servos ([the lift on the Pi](../../devices/pi/README.md#the-lift-under-the-motion-coordinator)). The simulator runs this flow as a script (`test/sim/lift/01-demo-flow.walk`: home, raise to the tray, the tray task, "Let go?", fold, lower), which passed 3 of 3 in real time at the simulator's made-up tray height of 300 mm. Nothing has run on the lift board, driver, motor or switches. **Skip the lift** unless it passed 3 of 3 on the walker that day ([rehearsal checklist](#rehearsal-checklist)); segment 8 then runs as written above.

**It needs the hardware stop, and runs in normal mode.** The lift never moves without the hardware stop wired, bench mode or not: bench mode waives the stop for the arms only. With today's limits the lift can't move in bench mode at all: homing's fixed 15 mm/s and the lift's built-in 50 mm/s² are above bench's 10 mm/s and 25 mm/s², so every lift target is refused ("The lift's built-in speed is above this mode's limit, so it won't move."). So the lift joins the segment only after its bring-up in normal mode: the stop wired to the arms and the lift, the pinch guards fitted, the drop test passed (or a brake fitted), and `WALKER_MOTION_BENCH` removed ([setup B, step 14](#b-the-real-pi-on-the-venue-network-server-on-render)). The arms then run in normal mode too, so say the stop's safety line, not the bench one.

**The rule for the lift** (as built):
- **Prepared** only from the terminal: `walker lift home` or `walker lift move <mm>`. It becomes the walker's one pending Confirm target, and the walker says it, for example "Raise the lift to 300 mm. Park the walker and lock the brakes, then press Confirm."
- **Started** only by a Confirm press on the left handle, while someone holds the screen's hold control and both arms are on and folded at `stowed`. Without the hold, the press is refused ("Keep holding the lift control to move it."); with an arm out, it's refused too. Nothing moves either way.
- **Moves only while held.** Letting go stops it ("Stopping"), and a stopped move never resumes: it needs a new target and a new Confirm.
- **Stopped** by any handle press (Talk or Confirm), the stop switch (which also cuts the lift's step signal itself), `walker motion stop`, or any fault. An obstacle screen taking over the walker's screen also lets go of the hold, so in every rehearsal stand where you'll stand on stage.

**Who is where** (on top of segment 8's roles):
- **The presenter holds the screen's hold control** with one hand and presses Confirm on the left handle with the other, then keeps holding until the screen says "Done". The rule asks for a person at the walker, and that's the presenter.
- **The teammate at the Pi's terminal** prepares each lift step (`walker lift home`, `walker lift move <mm>`), as for the arms, and keeps a hand on the lift's 12 V switch, as in its bring-up.
- **Judges stay outside the reach of the carriage and the arms** (the tape on the floor).

**Before the segment:** both arms on (`walker arms torque on`, then Confirm) and folded at `stowed`; the carriage left near the bottom, because the lift is unhomed whenever the walker service starts and after every stop and fault, and homing from the very top takes about 67 s (the contract's arithmetic, not measured); the object on its taped spot on the tray.

> "The lift moves only while a finger is on its control. Letting go stops it, and so does any button on either handle." †

1. **Home.** The teammate runs `walker lift home`. The walker says "Home the lift. Park the walker and lock the brakes, then press Confirm." † The screen shows "Home the lift" and the hold control, "Hold to home" with "and press Confirm" †. Hold it, wait 2 seconds, press Confirm. It goes down to the bottom switch and ends homed †. While it moves, the screen says "Keep holding" and "Let go, or press a handle button, to stop." †
2. **Raise to the tray.** The teammate runs `walker lift move <the tray height>`, the height the tray task was taught at. The walker says "Raise the lift to … mm." and the park line †, and the screen shows "Hold to raise" †. Hold, wait 2 seconds, press Confirm. It rises at up to the lift's built-in 20 mm/s (about 5 s for each 100 mm: arithmetic, not timed) and stops at that height †. Let go once the screen says "Done".
3. **The arm to `ready`, then the tray task and "Let go?":** `walker arms pose go ready --arm left` and Confirm, then steps 1 to 7 above. The tray task runs only with the lift homed and within 1 mm of the height it was taught at; otherwise it's refused, and the reason names the `walker lift move` that fixes it.
4. **Copy mode** (steps 8 to 10 above), if it's in today's run.
5. **Fold.** `walker arms pose go stowed --arm left` and Confirm. The lift won't move with an arm out.
6. **Lower.** The teammate runs `walker lift move <the starting height>`. The walker says "Lower the lift to … mm." and the park line †, and the screen shows "Hold to lower" †. Hold, wait 2 seconds, press Confirm, and keep holding until "Done".

> "A person at the walker holds the control and presses Confirm. That's the only way the lift moves." †

**If it stops partway** (a release, a press or a fault), the screen says "Stopping", then "Stopped" †. Say "It stops whenever I let go", and go on only with a new target and a new Confirm. A fault or the stop switch leaves the lift unhomed: home it again, or skip the rest of the lift.

## Fallbacks

- **The walker's screen doesn't show on the panel:** run the simulator on the laptop with `--screen` (setup A, step 7) and open its address in a browser window sized 800 by 480. Its strip says "Simulator". Say: "This is the walker's screen, drawn by the simulator on this laptop." Never show it as the Pi's screen.
- **The real Pi isn't working:** run beats 1 to 6 on the simulator (setup A), and say "This is the simulator on a laptop".
- **No obstacle board on the Pi:** skip beat 3, and in beat 4 say the cue change is saved for when the sensors are fitted.
- **The phones don't work:** either use two browser windows on the laptop at phone width, against the same server (each in its own browser or private window, so each keeps its own cookie, apart from the page's), and say "these two windows stand in for the phones"; or skip segment 7 and use the website's "Your walker" beat from [script.md](script.md#the-3-minute-script). Never use `/app?preview=`, which is sample data.
- **The lift:** skip it, and run segment 8 as written: the arms work at the carriage's fixed height. A tray task taught with the lift fitted runs only with the lift homed and at its taught height, so either raise the lift to that height before judges arrive (still with the hold and Confirm), or use a tray task taught with no `lift.json` on the Pi, which names no height. With no `lift.json` the walker has no lift.
- **The arms:** skip segment 8 unless it passed 3 of 3 that day. If anything moves that shouldn't, the teammate switches the arms' 12 V off first. If a fault shows ("Stopped" and its sentence), say "It stopped and holds; a helper clears it at the walker", and move on.
- **The agent is slow:** keep talking; the page's "Behind the scenes" panel shows what the server is doing.

## The spoken lines

Only the presenter speaks to the walker: the Gemini key is on the free tier, which is for scripted, made-up lines (see the honesty lines). Judges type on the page instead. Every alternate below for beats 2, 4 and 5 ran once in the 2026-10-23 rehearsal (two extra runs) and gave the same results. Beat 3's answer has been server-written since then, so its lines are † until rehearsed again.

| Beat | Line | Alternates | Must come back |
| --- | --- | --- | --- |
| 2 | "What can you help me with?" | "What are you able to do for me?"; "What can you do?" | A short list of what it can do (obstacles, parts, alerts). Model-written, so the wording changes each time |
| 3 | "Is anything in front of me?" | "Is there something ahead of me right now?"; "How far is the nearest thing?" | The server's line, built from the readings sent with Talk †: "The obstacle sensors read front left: 30 centimetres, just now; front right: 150 centimetres, just now. These readings are simulated." in the simulator. A zone without a fresh reading is "no current reading"; never "clear". Page: "Answered by the fixed replies" |
| 4 | "Stop buzzing me, use short sounds instead." | "I'd rather hear beeps than feel the handles shake."; "Can you use sounds instead of vibration?" | Exactly "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." (server-written) |
| 5 | "Can you pick up my keys?" | "Could you grab the glasses I dropped?"; "Can you reach the shelf for me?" | Exactly "This walker doesn't have robot arms, so I can't pick things up or move things." (only with no arms fitted) |
| 6 | Any line while offline | | "I'm offline right now. Your short-sound alerts still work." (plus "The obstacle sensor is simulated." in the simulator) |
| 7 | Typed by Maya: "Dinner at six. I'll get you." | | Read aloud on Rose's phone when she taps it; "I'm okay" back in Maya's thread † |
| 8 | No spoken line: the teammate's commands | | The task's title and "Park the walker and lock the brakes, then press Confirm."; then "Let go? Park the walker and lock the brakes, then press Confirm." † |

**For judges, typed on the page.** Click "Ask Sophi about your walker", type, press Enter. The page shows "You typed", and the reply arrives in about 2 seconds. Suggested lines:
- "Which of your parts are simulated?"
- "Are any of your parts not real hardware?"
- "Is anything in front of me?" (answered with the server's distance line †)

The notice above the box says where typed words go: Gemini, which may keep a copy; Cartesia, for the text of spoken replies; and that each message is deleted an hour after it's sent. Point at it before a judge types. Location and weather questions only work by Talk on the walker; typed, Sophi asks you to use Talk.

## Honesty lines

Say these when they come up, in these words or close to them.

- **Asking for help:** "Sophi doesn't call 911 and doesn't detect falls. When Rose asks, it goes to her caretaker's phone, and the walker only says it's showing there once her app has it. There are no push notifications yet, so the app has to be open."
- **What's simulated:** "This is the simulator on a laptop. Every part marked Simulated is a stand-in, and the page says Simulator for the whole walker." On the real Pi: "The Pi, its buttons, microphone and speaker are real. Anything still marked Simulated is a stand-in."
- **Who hears and who speaks:** "Google's Gemini hears my voice and writes the answer. Cartesia speaks it, and only Sophi's reply text goes to Cartesia, never my voice. Without Cartesia, the walker speaks with its own voice, and the page says which."
- **Why judges type:** "Our Gemini key is on the free tier, which is for scripted, made-up lines, and Cartesia's terms allow it to train on what it receives, so only I speak to it. You can type on the page; the notice says where typed words go."
- **What it can change:** "The model can only offer one change: how alerts reach you. Nothing changes until a person presses Confirm, and the offer expires after a minute. Voice can't confirm."
- **Obstacles:** "The buzz is a proximity cue from the walker itself, not collision avoidance. The spoken distances are the walker's own readings, written out by the server. A missing or old reading is 'no current reading', never clear."
- **The walker's screen:** "The screen shows what the walker is doing and the same words it says. So far it has run in the simulator, not on this panel" (until it has been rehearsed on the panel).
- **The phones:** "Rose and Maya are made up. The family approves Maya on the walker page after asking Rose; it isn't Rose's own Confirm on the walker yet. That agreement is checked, not stored. People nearby is sample data." And until they've run on real phones three times in a row, don't show them as working on phones.
- **Location (only if it's in the demo):** "Location sharing starts off, and only Rose's phone can turn it on. When it's on, the walker's latest GPS position goes to our server and to Maya's phone, and asking the walker where you are or about the weather sends one position to OpenStreetMap's or Open-Meteo's service. The GPS often has no fix indoors."
- **Motion:** "The arms move only when a person at the walker presses Confirm on a handle; the model, the phones and the website can't start them, and any handle press stops them." With no hardware stop wired: "There's no hardware stop yet, so they run in bench mode, and the screen says so." Before the arms have run on hardware: "The arm code is built and tested on simulated servos; it hasn't run on these arms yet." The lift, until it passed 3 of 3 on the walker: "The lift's code is built and tested against a simulated lift board; it hasn't moved this lift yet." With the lift in: "The lift moves only while a finger is on its control, after a Confirm press at the walker, with the arms folded, and never without the hardware stop."
- **Numbers:** only our own timings, and say they're ours (the rehearsal results below). On the real Pi there is one timed turn so far (about 4 seconds from letting go of Talk to the answer arriving); nothing else on the hardware is timed.
- **What's kept:** "Voice clips are sent to Gemini for one answer and dropped; Sophi never stores them. Google's free tier may keep what it receives. The words and replies are deleted from Sophi after an hour, or at once with Forget this walker. Messages between the phones are deleted after a day."
- **It's not Wren's walker:** if this follows the onboarding demo, "Wren's setup has voice off; this is a walker set up with voice on."

## Judge Q&A

**1. Is it always listening?** No. Nothing records until Talk is pressed, and it stops at release, or after 15 seconds. There's no wake word. The model never speaks unprompted; the walker's own lines (it's on, offline, back online, pair me again, the arms' Confirm prompts) are fixed and written in the Pi's code. A paired Pi asks the server to say them in Cartesia's voice, and says them in its own voice when that fails.

**2. What happens to my voice?**
- The clip goes to Google's Gemini with that one question, is held in memory for the turn, and is then dropped. Sophi never stores or logs it.
- The transcript and the reply are kept for an hour, so the page can show the conversation. "Forget this walker" deletes them at once.
- Typed words go to Gemini too. A reply the walker speaks goes to Cartesia as text when the server has a Cartesia key; replies to typed questions on the page aren't spoken, so they don't.
- On the free tiers, Google and Cartesia may use what they receive, so only scripted, made-up lines go to them.

**3. Why does it need Confirm?** A model's answer is never authority to change the walker. The model may offer one change, and the server checks it against fixed rules: a cue the walker can deliver, and never turning obstacle alerts off. The server writes the offer's words from the change itself. The change happens only when a person presses Confirm, by the offer's id, within a minute. The first answer wins. A second Confirm sees it's already done.

**4. What if the internet goes down?** The buttons and obstacle cues keep working on the walker. It says it's offline and answers Talk with a local line built from its current settings. It catches up when the network returns, and the page then shows everything it said. Measured on the simulator, with its own network switch, which fails requests at once: the walker counted itself offline 5.2 to 7.3 seconds after the cut and answered Talk at once. Once offline it retries after 10 seconds and then every 15 seconds, so it's back within about 15 seconds of the network returning (7.1 to 7.6 seconds in the rehearsal, by where the switch fell in that wait).

**5. What if the model is slow or fails?** A turn has 8 seconds on the server. Two Gemini models are asked at once, and the faster backup answers if the main one hasn't within 4.5 seconds (see question 8). If the models fail, or the main one refuses, a fixed answer built from the walker's status is used, and the page marks it "Answered by the fixed replies". If the server's answer doesn't arrive within 10 seconds, the walker gives up, counts itself offline and says its offline line. Some answers are fixed on purpose: the arms question, and since 2026-10-24 the obstacle readings, which the server writes from the walker's own numbers.

**6. Can it move?** The arms can, but only from a handle Confirm press at the walker, and the conversation can't start them.
- The model can't move anything. It can't even ask: the cloud may at most offer a taught skill or pose by its id, nothing sends such an offer yet, and even then it would only become a Confirm target.
- Every motor start needs a Confirm press on the handle, at least 2 seconds after the walker showed and said what will move, with the button seen released for those 2 seconds. Any handle press stops what moves.
- Each joint's goal stays within 5 degrees of where it is, so if the Pi stops mid-move, a joint goes at most 5 degrees further and holds.
- The hardware stop is designed to cut the arms' power and the lift's step signal without the Pi; it isn't wired yet. Without it the arms run only in bench mode, which the screen says, and the lift doesn't move at all.
- The lift moves only while someone holds its control on the walker's screen, after a Confirm press, with both arms folded; letting go or any handle press stops it.
- All of this is tested on simulated servos and a simulated lift board only; it hasn't run on the real arms or lift (until segment 8, or its lift part, passes 3 of 3).
- Apart from the arms, the only thing the walker makes a part do is play one of four fixed haptic patterns, for at most a second.

**7. How fast is it?** These are our timings from the rehearsal below, on a laptop with the simulator: from releasing Talk to the reply's text arriving, 1.9 to 4.6 seconds, with a median of 2.7 seconds, over 16 spoken turns; 2 of them took over 4 seconds. The walker then has to say it: the Pi writes the whole line with its own voice before playing it, so the time until it's heard is longer, and we haven't measured it. The target in our design is 4 seconds to the start of a spoken answer. On the real Pi, one timed turn so far: 3.96 seconds from letting go of Talk to the answer arriving from Render (2026-10-23); one turn isn't a timing range.

**8. Which models?** Google's Gemini hears the clip and writes the answer in one call. The server asks two Gemini models at once: `gemini-3.7-flash`, whose answer is used when it comes within 4.5 seconds, and the faster `gemini-3.6-flash` as a backup for the rest. In our live tests on 2026-10-23 the backup answered 26 of 210 turns at a 5-second switch-over and 12 of 60 at 4.5 seconds, and every answer it gave that was used was right. The page says "Gemini" for both. Cartesia's text-to-speech (`sonic-3.6`, a stock voice; no one's voice is cloned) speaks it; the server has had a key since 2026-10-23. If Cartesia's audio doesn't come, the walker speaks with its own voice (Piper on the Pi).

**9. Who can see the page?** The browser that paired the walker, through a cookie; there are no accounts yet. A walker is paired with a one-time 6-digit code that lasts 10 minutes. The walker gets its own key, and the server keeps only a hash of it. Five wrong codes lock pairing for 10 minutes. A phone gets in with its own one-time code from that page, and a caretaker's phone only after the page approves it.

**10. Does it work without sight or speech?** Every spoken answer also appears on the page, and as captions on the walker's screen (so far only in the simulator). Every offer can be confirmed from the page or the walker's button. The page works by keyboard and announces new replies, walker lines and offers once through a polite live region. It was checked by keyboard alone, at 390 px wide and at 200% zoom, and with reduced motion, in a headless browser against the page's development fake on 2026-10-23. The phone app was checked the same way, headless, at 200% text and by keyboard; Rose's message is read aloud only when she taps it. A VoiceOver or NVDA pass, and a check on real iPhones, are still to do.

**11. What's real hardware here?** On the Mac simulator, none of it, and the page says so on every part. On the real walker: the Raspberry Pi 5 running the walker service, its USB microphone and soundbar, both hand boards (Talk on the right, Confirm on the left), and a USB GPS that hasn't had a fix indoors. The obstacle sensors are still simulated or not fitted, and the page labels anything simulated. The obstacle board's firmware is tested on a computer but hasn't run with the Pi. The 5-inch screen, the arms and the lift are on the walker but haven't run with their software yet (unless segment 8, or its lift part, passed that day).

**12. Can the caretaker see where she is?** Only if Rose turns location sharing on from her own phone; it starts off. Then Maya sees the walker's latest GPS position, at most a minute old, and nothing older: no trail is kept, and turning it off erases it. The assistant never sees coordinates. Asking the walker "Where am I?" or about the weather sends one position to OpenStreetMap's Nominatim or Open-Meteo. None of this has been checked with a real GPS fix.

**13. What does Maya see?** Whether the walker is on, the alerts in force, each part's health, "Battery: not measured on this walker", short messages with Rose, and the location only if Rose shared it. Never Rose's conversation with Sophi, the walker's own lines, its obstacle readings, or when she used it.

## The 60-second cut

The walker is paired, on and "Online"; the page is open.

**0:00 to 0:10**

> "This is Sophi on the walker. Nothing listens until I hold Talk, and everything it hears or says shows up here."

**0:10 to 0:25**

1. Talk: "What can you help me with?" Point at "You said (as heard by Gemini)" and the reply.

**0:25 to 0:50**

1. Talk: "Stop buzzing me, use short sounds instead."
2. When it says "Press Confirm to do it", press Confirm.
3. Say the line while the alerts go to "Applied":

> "The model can only offer. It changed when I pressed Confirm, and the page says Applied only once the walker reports it."

**0:50 to 1:00**

> "The model can't move a motor, the parts marked Simulated are stand-ins, and it keeps its alerts working offline. That's Sophi."

## Joined with the onboarding demo (3 to 4 minutes)

1. **0:00 to 1:00:** the onboarding demo's [60-second cut](script.md#the-60-second-cut), stopping on Stripe's checkout page (don't pay).
2. **1:00 to 1:10, the bridge:**

   > "That's setting up a walker. This is the walker every day after. It isn't Wren's: her setup has voice off. This one has voice on."

   Switch to the walker page (a second browser tab, already open and "Online").
3. **1:10 to 3:10:** beats 2 to 6 above, from "What can you help me with?" to the walker coming back online. Skip beat 3 if time is short, and beat 5 if arms are fitted.
4. **3:10 to 3:30, the close:**

   > "Sophi is a prototype, not a certified mobility aid. The model never controls a motor, and every simulated part says so. What's real: she said what's hard, the walker drew itself around her, and every day after, a walker like this one can just be asked."

With more time, add segment 7 (one minute) before the close, and segment 8 (70 seconds) only if it passed 3 of 3 that day.

## Setup checklist

### A. The simulator on the Mac

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
3. **A throwaway database** (once). The folder path must be short, or Postgres can't create its socket; with `unix_socket_directories=''` it listens on TCP only. From a shell without a locale (an agent's shell), put `LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8` in front of `initdb` and `pg_ctl`:

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
   node devices/pi/dist/walker.mjs simulate --server http://localhost:3009 --state ~/steady-sim --mic mac --loud --screen
   ```

   - `--loud` plays its speech through the speakers; without it, speech is written to files.
   - `--screen` also serves the walker's screen and prints its address (`http://127.0.0.1:8740/`). Open it in a browser window sized 800 by 480 beside the page. Its strip says "Simulator".
   - Keys:
     - `t`: Talk (press, speak, press again);
     - `c`: Confirm;
     - `n`: a hand in front;
     - `f`: nothing in front;
     - `o`: the walker's network down, and up again;
     - `q`: quit.
   - **Without speaking:** `--mic-file <a folder of 16 kHz mono WAV clips>` instead of `--mic mac`. Number the clips (`1-ask.wav`, `2-obstacles.wav`, …): each Talk press plays the next one, starting again after the last. That's how the rehearsal ran; making clips is in [devices/pi/README.md](../../devices/pi/README.md#run-it-on-a-mac-simulator).
   - **Not rehearsed:** `--mic mac` and `--loud` with a live voice, and `--screen` against a real server.
8. **Beat 6 in the simulator.** Press `o` to take the walker's network down and `o` again to bring it back. Turning off the laptop's Wi-Fi doesn't do it: the walker talks to `localhost`.
9. **Screen.** Put the browser, the walker's screen window and the simulator's terminal side by side; the terminal is the walker's buttons. Click once on an empty part of the page, so the walker's name doesn't keep the focus ring it gets when the page switches to the walker. Close everything else. Do Not Disturb on.
10. **Phones (segment 7).** The phones can't reach `localhost` on the laptop: against the simulator, use the fallback (two browser windows at phone width on <http://localhost:3009/app>, each in its own browser or private window), or run segment 7 on Render (setup B).
11. **Reset between judges.** On the page, "Forget this walker" (it also deletes the circle), then pair again (step 6) and restart the walker (step 7), so each judge sees the same starting state (vibration alerts, version 1).

### B. The real Pi on the venue network, server on Render

Needs Max. On the night of 2026-10-23 the Pi steps ran up to one spoken turn: OS, Node, the service, pairing with Render, the USB mic and soundbar, Piper, and one ESP32 hand board for Talk ([what each showed](../../devices/pi/README.md#set-up-the-pi)). On 2026-10-24 both hand boards ran with it, and Talk gave answered turns. Not yet run on the Pi: Confirm on an offer, an obstacle board, the screen, the arms, and the six beats in order.

1. **Render** (Max, once): follow [Deploy on Render](../../apps/web/README.md#deploy-on-render). Paste `GEMINI_API_KEY`, and `CARTESIA_API_KEY` if there is one (or `none`). Check that `/api/v1/health` on the Render address says `{"status":"ok","walker_store":"postgres"}`. If this Mac's network filter blocks `onrender.com`, open the page on a phone or iPad.
2. **The Pi** (Max): follow the Pi checklist in [devices/pi/README.md](../../devices/pi/README.md#set-up-the-pi):
   - OS and Node 22;
   - Talk on the right hand board and Confirm on the left, or Talk on GPIO17 and Confirm on GPIO27 declared with `WALKER_GPIO_BUTTONS=wired`;
   - a USB microphone and speaker;
   - the systemd service.

   Each step there says what to check.
3. **Network.** Cal Hacks prohibits personal hotspots, routers and other broadcasting equipment in the venue, and says it can detect them, so the Pi can't use Max's phone hotspot there. Never unplug the venue's access points or switches.
   - **Primary: Ethernet.** There's a hardline switch every 3 tables. Request a cable in the Cal Hacks app first, then pick it up at the Hardware Checkout window. Plug it from the switch into the Pi 5's own Ethernet port (gigabit, no adapter). NetworkManager on Raspberry Pi OS Lite trixie is expected to get an address on `eth0` by itself (DHCP); that hasn't been run on this Pi. Check: `nmcli device` shows `eth0` as `connected`, and the page shows the walker online.
   - **Backup only: the venue Wi-Fi,** if Ethernet fails, and only if it has no sign-in web page (the Pi has no browser) and doesn't ask for a username (WPA2-Enterprise). About 3,000 people share it. The Pi 5's Wi-Fi is Wi-Fi 5 on 5 GHz: it works with the venue's Wi-Fi 6 access points, but expect congestion (2.4 GHz is only on the Mezzanine). Add it as in [the Pi's network notes](../../devices/pi/README.md#the-network-ethernet-first-wi-fi-as-a-backup), then turn its autoconnect off.
   - **Keep the Wi-Fi backup off for the demo.** If the Pi also has a working Wi-Fi network saved and turned on, unplugging Ethernet in beat 6 fails over to Wi-Fi and the walker does NOT go offline. So keep the venue Wi-Fi off unless Ethernet has failed, and do the same for any other saved Wi-Fi network in range. These NetworkManager commands are *not yet run on the Pi*:

     ```bash
     nmcli connection show            # the saved connections; Wi-Fi ones have TYPE wifi
     sudo nmcli connection modify "walker: <venue network>" connection.autoconnect no
     sudo nmcli connection down "walker: <venue network>"   # only if it's connected now
     nmcli device                     # eth0 "connected"; wlan0 not connected
     # Only if Ethernet has failed:
     sudo nmcli connection up "walker: <venue network>"
     ```

     Use the name `nmcli connection show` lists; the walker's own Wi-Fi scripts name it `walker: <network name>`. With the Wi-Fi backup in use, there's no cable to pull for beat 6: skip it.
   - **The laptop** stays on its own connection (the venue Wi-Fi), so beat 6 takes only the walker offline. **The two phones** use cellular.
   - **Reaching the Pi:** venue networks often keep devices from reaching each other, so SSH from the laptop may not work there. Fallbacks are in [the Pi's network notes](../../devices/pi/README.md#the-network-ethernet-first-wi-fi-as-a-backup). Segment 8 needs a terminal on the Pi, so settle this before planning on it.
4. **Pair:** open `/walker` on the Render address, press "Get a pairing code", and on the Pi run the pair command from the Pi checklist with `--server https://<the Render address>`. The page switches to the walker. On a sleeping free server the first request can take a minute: the Pi wakes it before using the code.
5. **Obstacle sensors and hand boards:** both hand boards (`hand-right-01` for Talk, `hand-left-01` for Confirm) ran with the Pi on 2026-10-24: right Talk gave answered turns and the left handle gave the Confirm press cue. Confirm answering an offer hasn't been tried. The obstacle board hasn't run. If no sensor board is connected, the page shows "No obstacle sensors reporting." In that case skip beat 3, and in beat 4 say the cue change is saved for when the sensors are fitted. After a full power cycle, if Talk does nothing, wait: the handles took about six minutes to connect on 2026-10-24 (`journalctl -u steady-walker -b` shows `module said hello` when they're in).
6. **Cartesia,** only with a key: the page says "In Cartesia's voice"† under spoken replies. Its terms (read 2026-10-23) allow training on inputs unless agreed otherwise, so the same scripted-lines-only rule as Gemini's free tier applies.
7. **Run it once** on the venue network: all six beats, including the Ethernet cable out at the Pi and back in. Time beat 6 (the offline line after unplugging, and "I'm back online." after plugging in); neither is measured.
8. **Card on the walker:** "Only the presenter speaks to this walker. Type on the page instead; it says where typed words go."
9. **`walker check`** before each session, with the service stopped for the boards and arms: `sudo node /opt/steady-walker/walker.mjs check` ([what it checks](../../devices/pi/README.md#check-the-walker-first-walker-check)). It only reads: it never moves an arm or the lift. It hasn't run on the Pi yet, so its first run there is itself a check of the check.
10. **The screen** (not yet run on the Pi): `sudo apt install -y cage chromium curl`, then `sudo ./scripts/install-pi.sh --screen walker.mjs` and a reboot ([the screen](../../devices/pi/README.md#the-screen)). Check that the panel goes from the placeholder ("Sophi", "Screen connected.") to the walker's clock, then rehearse beats 1 to 6 with it three times. How much memory the browser takes next to Piper isn't measured: if replies get slower with the screen on, turn it off (`sudo systemctl disable --now sophi-screen`) and use the fallback.
11. **The phones** (segment 7): both on cellular, `/app` on the Render address open and added to the Home Screen, Rose's phone linked before judges arrive. Between judges, remove Maya's phone on the Phones card ("Remove", then "Remove" again; "Keep it" cancels), so the next judge sees her join. A code lasts 10 minutes and a waiting phone 5, so make Maya's code during the segment, not before.
12. **The arms** (segment 8), only after the bench bring-up and the tray task are done ([bench bring-up](../../devices/pi/README.md#bench-bring-up-with-real-arms-2026-10-25-plan-nothing-below-has-been-done-yet)): the arm ports in `/etc/steady-walker.env`, bench mode on until the hardware stop is wired and passed 3 of 3, the tray and the object's spot taped, tape on the floor at the arms' reach, the left arm on and at `ready`, and a way into the Pi's terminal. Then rehearse segment 8 three times in a row that day, or skip it.
13. **Beat 5 on this walker:** if the arms are fitted, skip beat 5 (its line would be untrue).
14. **The lift** (inside segment 8), only after its own bring-up ([the lift's bring-up](../../devices/pi/README.md#bench-bring-up-with-the-real-lift-after-the-arms-2026-10-25-plan-nothing-below-has-been-done-yet)). The lift needs the hardware stop wired even in bench mode, and with today's limits it can't move in bench mode at all, so its bring-up runs in normal mode, after:
    - the arms' bring-up, with the stop wired and `WALKER_MOTION_BENCH` removed;
    - the lift board's own bench steps, the drop test among them ([the lift board](../../firmware/README.md#lift-board));
    - the pinch guards fitted;
    - the stop's second contact wired to the lift board, and the stop tested on both;
    - `lift.json` written with the board's configuration, the guards and the drop test result.

    Then run the lift's stop tests (a release, a Talk press, a Confirm press, the stop switch) and record how far it went after each in `hardware/current-build.md`. The walker's screen must be on the panel (step 10), because the hold control is on it: the simulator's screen on the laptop can't hold the real lift. Teach the tray task at the tray height, then rehearse the lift's flow three times in a row that day, or skip it.

## Rehearsal checklist

Rehearse each segment three times in a row on the setup you'll demo, on the day, plus a run with fresh wordings for beats 2 to 5. Tick a box only when the run passed every step in that segment with the lines in "Must come back"; a failed run starts the count again. Write the date, the commit and any timing next to each.

| Segment | Setup | Run 1 | Run 2 | Run 3 | Fresh wordings | Date, commit, notes |
| --- | --- | --- | --- | --- | --- | --- |
| Beats 1 to 6 | Simulator, with `--screen` | [ ] | [ ] | [ ] | [ ] | |
| Beats 1 to 6 | Real Pi on Ethernet, page on Render | [ ] | [ ] | [ ] | [ ] | |
| Beat 3, the server's distance line | Either | [ ] | [ ] | [ ] | [ ] | |
| The walker's screen through beats 1 to 6 | Real Pi and panel | [ ] | [ ] | [ ] | | |
| Beat 6, cable out and back | Real Pi on Ethernet | [ ] | [ ] | [ ] | | Time to the offline line, and to "I'm back online." |
| Segment 7, two phones | Two real phones on cellular, Render | [ ] | [ ] | [ ] | | |
| Segment 8, the taught task and "Let go?" | Real walker, real arms | [ ] | [ ] | [ ] | | Stop wired or bench mode |
| Segment 8, copy mode and a handle-press stop | Real walker, real arms | [ ] | [ ] | [ ] | | |
| Segment 8 with the lift: home, raise to the tray, the tray task, "Let go?", lower | Real walker, real arms and lift, stop wired, normal mode | [ ] | [ ] | [ ] | | Who held the screen's control; the tray height; how long the segment took |
| The lift: a release partway, and a handle press, each stop it | Real walker, real lift, stop wired, normal mode | [ ] | [ ] | [ ] | | How far it went after each |
| The 60-second cut | The setup you'll demo | [ ] | [ ] | [ ] | | |
| Joined with the onboarding demo | The setup you'll demo | [ ] | [ ] | [ ] | | |

After a passed set, take the † off the lines you saw and heard, with the date, in the same change.

## Requests

**Open before the demo**, each with what it needs:
1. **Beat 5 with the arms fitted.** On a walker with arms, the server's no-arms line is untrue, so beat 5 is skipped. To keep a beat 5, the Pi has to list `manipulation.arm` and `MANIFEST_MAY_LIST_ARMS` has to be set to true after the arms pass 3 of 3 (see beat 5's alternative). Decision: Max.
2. **The lift.** Wired into the motion coordinator since 2026-10-24 (tested only against a simulated lift board). Still to do: the lift board's bench steps and drop test, the guards, the stop wired to the lift, and its bring-up on the Pi in normal mode (setup B, step 14). Until then the lift isn't in the demo.
3. **The hardware stop.** Chosen in the contract, not bought or wired. Until it is, the arms run only in bench mode, nobody else is within their reach, and the lift can't move at all.
4. **The two phones after GPS sharing.** The three headless runs were before the opt-in GPS sharing changed the consent line and Rose's "My walker" screen. Run segment 7 again, ideally on two real phones.
5. **Location sharing and the location and weather questions:** in the demo or not (Max).

**Fixed since the first rehearsal** (on `main` at `37a691c`, and checked in this rehearsal):
- #45, the Pi: `--mic-file` takes a folder or list and re-reads each clip at its press; `o` and `g` take the simulator offline against a real server; "Applied" comes within about half a second of the walker's Confirm; the offline line reaches the page once.
- #44, the server: "All of this walker's parts are simulated." when every reported part is.
- #43, the contract: `answered_by` is `fixed` whenever a fixed reply replaced the model's, as the server does.

**Found in this rehearsal,** each with an owner:
1. **Server: an age in milliseconds, read aloud. Fixed** (branch `claude/walker-turn-wording`). One of five obstacle answers said "…at 30 centimetres from 44 milliseconds ago." The others said "just now", "right now" or "less than a second ago". The model was shown each reading's age in milliseconds. Now it's shown the age already worded as it should be said (`reading_age`: "just now" under a second, then whole seconds such as "3 seconds ago"). Measured live on Gemini, typed "Is anything in front of me?" on an all-simulated walker: before, 1 of 5 answers said milliseconds (44 ms readings); after, 0 of 5 at 44 ms, all saying "just now", and 0 of 3 at 3.2 s, all saying "3 seconds ago". Since 2026-10-24 the server writes the whole obstacle answer itself, with the same wording for the age.
2. **Server: the simulated line repeated the model. Fixed** (same branch). All four "which parts…" answers already said every part is simulated before the server added "All of this walker's parts are simulated." The rule is structured and can't see the words. Now the policy tells the model the server adds that line itself (when every part is simulated and the question isn't about obstacles), so it leaves it out; the server's rule is unchanged and still the guarantee. Measured live on Gemini, typed "Which of your parts are simulated?", "Are any of your parts not real hardware?" and "Which parts of my walker are working right now?": before, 5 of 5 answers said every part is simulated before the server's line; after, 0 of 5, each naming the parts and their health ("…are healthy.") followed by the server's line.
3. **Page: two announcements in the wrong order.** Now that "Applied" comes within half a second, it lands in the same poll as the offer's closing, and the live region reads "Your walker applied the new alerts. Confirmed. Switching your alerts to …". Smallest fix: in `useWalkerPage.ts`'s `applyList`, put the offer's closing line before the walker's other news. Owner: the page (this script's author). **Fixed** on branch `claude/walker-page-announce-order`: `applyList` now reads any connection line first, then the offer's closing, then the walker's news (`readingOrder` in `walkerView.ts`), so it reads "Confirmed. Switching your alerts to … Your walker applied the new alerts." Not yet re-rehearsed with the simulator.
4. **Page Confirm, by design:** after the page's Confirm, "Applied" took about 6 seconds, because the walker hears of it with its next report (every 5 seconds). The script says to keep talking; no change needed.

## Rehearsal results

**Date:** 2026-10-23, 05:31 to 05:39 PDT (five runs; times from the simulator's logs). These runs came before the rename on 2026-10-23, so the boot line they checked was "Steady is on."; it is now "Sophi is on.". They also came before the walker's screen, the phones, the arms, and the server-written obstacle answer (beat 3 then had the model's own words), so none of those is checked here. **Code:** `main` at `37a691c`, as merged, with no patches: the server (#31, #39, #44), the page (#34), the Pi service (#36, #45) and the contract (#43). **Setup:**
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
- **Boot:** "Sophi is on." 0.1 to 0.2 s after start; the page "Online" in about 1.5 s; every part "Healthy" and "Simulated", including "Walker and coordinator"; alerts "Version 1", "Applied".
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
  3. "Sophi offers: Switch your alerts from buzzing to short sounds. Confirm or decline within a minute.";
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
- the real Pi, its buttons, microphone and speaker, and its Ethernet (unplugging and plugging back in);
- Render;
- Cartesia's voice;
- `--mic mac` and `--loud` with a live voice;
- the ESP32 boards;
- the venue network: its Ethernet, its Wi-Fi, and whether the laptop can reach the Pi by SSH;
- the projector;
- a VoiceOver pass;
- the walker's screen, the phones and the arms, which came later.
