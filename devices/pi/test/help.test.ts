import { HELP_CHORD_WINDOW_MS, type DeviceTurnRequest, type ScreenState } from "@walker/contracts";
import { describe, expect, it } from "vitest";
import type { ButtonName } from "../src/bus";
import { attachLogging } from "../src/logging";
import { LINES } from "../src/notices";
import { attachScreen, seedScreen, startingSettings } from "../src/screen/attach";
import { FakeCloudError } from "../src/sim/fakeCloud";
import { helpText, parseScript } from "../src/sim/script";
import { boot, captureLogger, flush, lone, makeHarness, type Harness } from "./support/fakes";

/** Rows GH1 to GH36 of test/EXPECTED.md ("Asking for help"). Every time comes from a fake clock. */

const SENT = "Sent to Maya's phone.";
const ASKING = "Asking for help.";
const STOPPED = "Okay. I didn't ask anyone.";
const RETRYING = "No internet yet. I'll keep trying.";
const OFFLINE = "I couldn't reach the internet, so nothing was sent. Use your phone if you can.";
const FAILED = "Something went wrong, so nothing was sent. Use your phone if you can.";
const NO_CARETAKER = "No caretaker's phone is linked to this walker, so nothing was sent.";
const VOICE_REPLY = "I'll ask Maya for help in 8 seconds. Press any button to stop.";
const MAYA = { member_id: "00000000-0000-4000-8000-00000000ca01", name: "Maya" };
const SAM = { member_id: "00000000-0000-4000-8000-00000000ca02", name: "Sam" };
const SAM_TOO = { member_id: "00000000-0000-4000-8000-00000000ca03", name: "Sam" };

type H = Harness & { helps: string[]; last: () => string; bodies: DeviceTurnRequest[] };

/** A harness that also records the help layer (as the script runner words it) and every turn request body. */
function harness(options: Parameters<typeof makeHarness>[0] = {}): H {
  const h = makeHarness(options);
  const helps: string[] = [];
  h.bus.on("help", ({ screen }) => helps.push(helpText(screen)));
  const bodies: DeviceTurnRequest[] = [];
  const turn = h.fake.turn.bind(h.fake);
  h.fake.turn = (device, body) => {
    bodies.push(body);
    return turn(device, body);
  };
  return Object.assign(h, { helps, last: () => helps.at(-1) ?? "none", bodies });
}

const asks = (h: Harness) => h.client.calls.filter((c) => c === "help:ask").length;
const statuses = (h: Harness) => h.client.calls.filter((c) => c === "help:status").length;
const okays = (h: Harness) => h.client.calls.filter((c) => c === "help:okay").length;
const helpLines = (h: Harness) => h.spoken("help");
const other = (b: ButtonName): ButtonName => (b === "talk" ? "confirm" : "talk");

/** Both handle buttons down on the Pi's GPIO, `first` first. */
async function down(h: Harness, first: ButtonName = "talk", gapMs = 0): Promise<void> {
  h.press(first, "pressed");
  await flush();
  if (gapMs) await h.clock.advance(gapMs);
  h.press(other(first), "pressed");
  await flush();
}

async function up(h: Harness): Promise<void> {
  h.press("talk", "released");
  h.press("confirm", "released");
  await flush();
}

/** A whole chord: both down, held `ms`, both up. */
async function chord(h: Harness, ms = 2000): Promise<void> {
  await down(h);
  await h.clock.advance(ms);
  await up(h);
}

async function talk(h: Harness, ms = 2000): Promise<void> {
  h.press("talk", "pressed");
  await h.clock.advance(ms);
  h.press("talk", "released");
  await flush();
}

/** Booted, with the first heartbeat's help poll answered (so turns may carry can_ask_for_help). */
async function booted(options: Parameters<typeof makeHarness>[0] = {}): Promise<H> {
  const h = harness(options);
  await boot(h);
  return h;
}

/** A request open after a chord ("Sent to Maya's phone."). */
async function opened(h: H): Promise<void> {
  await chord(h);
  expect(h.last()).toBe("help open");
}

const deviceHelp = (h: Harness) => h.device()!.help;

describe("the chord and who owns Confirm", () => {
  it("GH1: both buttons held 2 s asks once (source handles), with the help cue and help_hold first", async () => {
    const h = await booted();
    await down(h);
    expect(h.speaker.cues).toContain("help");
    expect(h.last()).toBe("help_hold");
    await h.clock.advance(1999);
    expect(asks(h)).toBe(0);
    await h.clock.advance(1);
    expect(asks(h)).toBe(1);
    expect(deviceHelp(h)).toHaveLength(1);
    expect(deviceHelp(h)[0]!.source).toBe("handles");
    expect(deviceHelp(h)[0]!.clientIds.size).toBe(1);
    expect(helpLines(h)).toEqual([ASKING, SENT]);
    expect(h.helps).toEqual(["help_hold", "help sending", "help open"]);
    await up(h);
    await h.clock.advance(5000);
    expect(asks(h)).toBe(1);
  });

  it("GH2: let go at 1.9 s: nothing sent or said, the screen goes back; both again starts from 0", async () => {
    const h = await booted();
    await down(h);
    await h.clock.advance(1900);
    h.press("confirm", "released");
    await flush();
    expect(h.last()).toBe("none");
    await h.clock.advance(1000);
    expect(asks(h)).toBe(0);
    expect(helpLines(h)).toEqual([]);
    h.press("talk", "released");
    await flush();
    await down(h);
    await h.clock.advance(1999);
    expect(asks(h)).toBe(0);
    await h.clock.advance(1);
    expect(asks(h)).toBe(1);
  });

  it("GH3: Talk first: the recording it opened is dropped (discarded, no turn), and the release sends nothing", async () => {
    const h = await booted();
    h.press("talk", "pressed");
    await flush();
    expect(h.capture.starts).toBe(1);
    expect(h.service.talk).toBe("recording");
    h.press("confirm", "pressed");
    await flush();
    expect(h.capture.aborts).toBe(1);
    expect(h.service.talk).toBe("idle");
    expect(h.named("turn").map((t) => t.outcome)).toEqual(["discarded"]);
    await h.clock.advance(500);
    await up(h);
    await h.clock.advance(3000);
    expect(h.client.calls).not.toContain("turn");
    expect(h.spoken("local_reply")).not.toContain(LINES.stoppedListening);
  });

  it("GH4: Confirm first with nothing to start acts at once; Talk in the window then makes the chord, no mic", async () => {
    const h = await booted();
    h.press("confirm", "pressed");
    await flush();
    expect(h.speaker.cues).toEqual(["nothing_to_confirm"]);
    await h.clock.advance(100);
    h.press("talk", "pressed");
    await flush();
    expect(h.speaker.cues).toEqual(["nothing_to_confirm", "help"]);
    expect(h.capture.starts).toBe(0);
    expect(h.last()).toBe("help_hold");
  });

  it("GH4: Confirm first with a message of hers reads it again at once, then the chord", async () => {
    const h = await booted();
    await h.clock.advance(5000);
    h.fake.sendFromCaretaker(h.device()!.deviceId, "Maya", "Dinner at six.");
    await h.clock.advance(5000);
    expect(h.spoken("message")).toHaveLength(1);
    await down(h, "confirm", 100);
    expect(h.spoken("message")).toHaveLength(2);
    expect(h.last()).toBe("help_hold");
  });

  it("GH5: a Confirm that would answer a proposal, then Talk within 250 ms: the proposal isn't answered", async () => {
    const h = await booted();
    h.fake.script = [{ reply: "Fake cloud: short sounds? Press Confirm.", proposeCues: ["sound"] }];
    await talk(h);
    expect(h.service.openProposal).not.toBeNull();
    await down(h, "confirm", HELP_CHORD_WINDOW_MS - 10);
    await h.clock.advance(1000);
    expect(h.client.calls.filter((c) => c.startsWith("answer:"))).toEqual([]);
    expect(h.last()).toBe("help_hold");
  });

  it("GH5: a Confirm tap (already let go) then Talk within 250 ms: the Confirm is dropped, and Talk is Talk", async () => {
    const h = await booted();
    h.fake.script = [{ reply: "Fake cloud: short sounds? Press Confirm.", proposeCues: ["sound"] }];
    await talk(h);
    expect(h.service.openProposal).not.toBeNull();
    // A second question is waiting for its answer, so the Talk press below cancels it and leaves Talk idle.
    h.client.hold.add("turn");
    await talk(h);
    expect(h.service.talk).toBe("waiting");
    h.press("confirm", "pressed");
    h.press("confirm", "released");
    await h.clock.advance(100);
    h.press("talk", "pressed");
    h.press("talk", "released");
    await h.clock.advance(1000);
    expect(h.spoken("local_reply")).toContain(LINES.cancelled);
    expect(h.client.calls.filter((c) => c.startsWith("answer:"))).toEqual([]);
    expect(h.speaker.cues).not.toContain("help");
  });

  it("GH5: Confirm then Talk within 250 ms while help is open: nothing is armed", async () => {
    const h = await booted();
    await opened(h);
    await down(h, "confirm", 100);
    await h.clock.advance(150);
    expect(helpLines(h)).not.toContain("Press Confirm again to tell Maya you're okay.");
    expect(h.helps.filter((x) => x.includes("confirm_okay"))).toEqual([]);
  });

  it("GH6: a lone Confirm on a proposal answers 250 ms after its press, once; Talk after the window is Talk", async () => {
    const h = await booted();
    h.fake.script = [{ reply: "Fake cloud: short sounds? Press Confirm.", proposeCues: ["sound"] }];
    await talk(h);
    h.press("confirm", "pressed");
    h.press("confirm", "released");
    await h.clock.advance(HELP_CHORD_WINDOW_MS - 1);
    expect(h.client.calls.filter((c) => c.startsWith("answer:"))).toEqual([]);
    await h.clock.advance(1);
    expect(h.client.calls.filter((c) => c.startsWith("answer:"))).toEqual(["answer:confirm"]);
    h.press("talk", "pressed");
    await flush();
    expect(h.service.talk).toBe("recording");
  });

  it("GH7: the simulator keyboard never makes a chord and never waits", async () => {
    const h = await booted();
    h.press("talk", "pressed", "keyboard");
    await flush();
    h.press("confirm", "pressed", "keyboard");
    await flush();
    expect(h.speaker.cues).not.toContain("help");
    expect(h.service.talk).toBe("recording");
    expect(parseScript("chord 2500\nchord 1900")).toEqual([
      { kind: "chord", holdMs: 2500, line: 1 },
      { kind: "chord", holdMs: 1900, line: 2 },
    ]);
    expect(() => parseScript("chord")).toThrow(/hold in ms/);
  });

  it("GH7: the chord through a real ESP32 hand board (both buttons on one board in the simulator)", async () => {
    const h = harness({ withHand: true });
    await boot(h);
    h.hand!.press("talk", "pressed");
    h.hand!.press("confirm", "pressed");
    await h.clock.advance(2000);
    h.hand!.press("talk", "released");
    h.hand!.press("confirm", "released");
    await h.clock.advance(1000);
    expect(asks(h)).toBe(1);
    expect(h.client.calls).not.toContain("turn");
    expect(helpLines(h)).toEqual([ASKING, SENT]);
  });

  it("GH9: while help owns Confirm, a turn's proposal is declined and its message draft dropped; a heartbeat's isn't adopted", async () => {
    const h = await booted();
    await opened(h);
    h.fake.script = [
      { reply: "Fake cloud: short sounds? Press Confirm.", proposeCues: ["sound"] },
      { reply: "Send Maya: On my way? Press Confirm.", offerMessage: { to_name: "Maya", text: "On my way" } },
    ];
    await talk(h);
    expect(h.service.openProposal).toBeNull();
    await h.clock.advance(5000);
    expect(h.client.calls.filter((c) => c === "answer:decline")).toHaveLength(1);
    await talk(h);
    await h.clock.advance(2000);
    // The draft isn't kept: a lone Confirm arms help instead of sending it.
    await lone(h);
    expect(helpLines(h)).toContain("Press Confirm again to tell Maya you're okay.");
  });
});

describe("voice, sending and polling", () => {
  it("GH10: an older server (404 on /help): turns carry no can_ask_for_help", async () => {
    const h = harness();
    h.fake.helpRoutes = false;
    await boot(h);
    await talk(h);
    expect(h.bodies).toHaveLength(1);
    expect(h.bodies[0]!.can_ask_for_help).toBeUndefined();
  });

  it("GH11: after a 200 every request of a turn carries can_ask_for_help, a tool continuation too", async () => {
    const h = await booted();
    expect(statuses(h)).toBeGreaterThan(0);
    const client = h.client;
    const turn = client.turn.bind(client);
    let first = true;
    client.turn = async (body, signal) => {
      const reply = await turn(body, signal);
      if (!first) return reply;
      first = false;
      return { ...reply, tool_call: { name: "get_distance" }, turn: { ...reply.turn, heard: "How far is the door?" } };
    };
    await talk(h);
    await h.clock.advance(1000);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies.map((b) => b.can_ask_for_help)).toEqual([true, true]);
    expect(h.bodies[1]!.tool_results).toBeDefined();
  });

  it("GH12: ask_for_help: the reply, then 8 to 1 once a second, then one POST with source voice", async () => {
    const h = await booted();
    h.fake.script = [{ reply: "unused", askForHelp: true }];
    await talk(h);
    expect(h.spoken("reply")).toEqual([VOICE_REPLY]);
    expect(h.last()).toBe("help_countdown 8");
    for (let left = 7; left >= 1; left -= 1) {
      await h.clock.advance(1000);
      expect(h.last()).toBe(`help_countdown ${left}`);
    }
    expect(asks(h)).toBe(0);
    await h.clock.advance(1000);
    expect(asks(h)).toBe(1);
    expect(deviceHelp(h)[0]!.source).toBe("voice");
    expect(helpLines(h)).toEqual([ASKING, SENT]);
  });

  for (const button of ["talk", "confirm"] as const) {
    it(`GH13: ${button} at 3 s stops the countdown; the press does nothing else; the next press acts as usual`, async () => {
      const h = await booted();
      await h.clock.advance(5000);
      h.fake.sendFromCaretaker(h.device()!.deviceId, "Maya", "Dinner at six.");
      await h.clock.advance(5000);
      const messages = h.spoken("message").length;
      h.fake.script = [{ reply: "unused", askForHelp: true }];
      await talk(h);
      const starts = h.capture.starts;
      await h.clock.advance(3000);
      h.press(button, "pressed");
      await flush();
      h.press(button, "released");
      await flush();
      expect(helpLines(h)).toEqual([STOPPED]);
      expect(h.last()).toBe("none");
      await h.clock.advance(10_000);
      expect(asks(h)).toBe(0);
      expect(h.capture.starts).toBe(starts);
      expect(h.spoken("message")).toHaveLength(messages);
      expect(h.speaker.cues).not.toContain("nothing_to_confirm");
      h.press("talk", "pressed");
      await flush();
      expect(h.service.talk).toBe("recording");
    });
  }

  it("GH13: a press while the reply still plays stops it, and no countdown starts", async () => {
    const h = await booted();
    h.fake.script = [{ reply: "unused", askForHelp: true }];
    h.speaker.hold = true;
    await talk(h);
    expect(h.speaker.spoken).toContain(VOICE_REPLY);
    h.press("confirm", "pressed");
    await flush();
    expect(h.speaker.stopped).toContain(VOICE_REPLY);
    h.speaker.finish();
    await h.clock.advance(10_000);
    expect(h.helps.filter((x) => x.startsWith("help_countdown"))).toEqual([]);
    expect(asks(h)).toBe(0);
    expect(helpLines(h)).toEqual([STOPPED]);
  });

  it("GH14: network down: said once, retrying on screen, a try every 5 s with one client id, then sent", async () => {
    const h = await booted();
    h.client.network = "down";
    await chord(h);
    expect(helpLines(h)).toEqual([ASKING, RETRYING]);
    expect(h.last()).toBe("help sending retrying");
    await h.clock.advance(10_000);
    expect(asks(h)).toBe(3);
    h.client.network = "up";
    await h.clock.advance(5000);
    expect(asks(h)).toBe(4);
    expect(helpLines(h)).toEqual([ASKING, RETRYING, SENT]);
    expect(deviceHelp(h)).toHaveLength(1);
    expect(deviceHelp(h)[0]!.clientIds.size).toBe(1);
  });

  it("GH14: a 5xx and a hang past the 10 s deadline count as failures too", async () => {
    const h = await booted();
    const ask = h.fake.askForHelp.bind(h.fake);
    let fail = 1;
    h.fake.askForHelp = (device, body) => {
      if (fail-- > 0) throw new FakeCloudError("unavailable", "Down for a moment.");
      return ask(device, body);
    };
    await chord(h);
    expect(h.last()).toBe("help sending retrying");
    h.client.network = "hang";
    await h.clock.advance(5000 + 10_000);
    expect(h.last()).toBe("help sending retrying");
    h.client.network = "up";
    await h.clock.advance(5000);
    expect(h.last()).toBe("help open");
    expect(helpLines(h).filter((l) => l === RETRYING)).toHaveLength(1);
  });

  it("GH15: never through: tries every 5 s while within 120 s of the first, then not sent offline, no more tries", async () => {
    const h = await booted();
    h.client.network = "down";
    await chord(h);
    const start = h.clock.monotonic();
    await h.clock.advance(119_000);
    expect(h.last()).toBe("help sending retrying");
    await h.clock.advance(2000);
    expect(asks(h)).toBe(25);
    expect(helpLines(h).at(-1)).toBe(OFFLINE);
    expect(h.helps).toContain("help not_sent offline");
    expect(h.clock.monotonic() - start).toBeLessThan(125_000);
    await h.clock.advance(60_000);
    expect(asks(h)).toBe(25);
  });

  it("GH16: 409 no_caretaker: not sent, no retry", async () => {
    const h = await booted();
    h.fake.caretakers = [];
    await chord(h);
    expect(helpLines(h)).toEqual([ASKING, NO_CARETAKER]);
    expect(h.last()).toBe("help not_sent no_caretaker");
    await h.clock.advance(30_000);
    expect(asks(h)).toBe(1);
  });

  for (const code of ["invalid_request", "rate_limited", "unauthenticated"] as const) {
    it(`GH17: another 4xx (${code}): not sent failed, no retry${code === "unauthenticated" ? ", and pair again" : ""}`, async () => {
      const h = await booted();
      h.fake.askForHelp = () => {
        throw new FakeCloudError(code, "No.");
      };
      await chord(h);
      expect(helpLines(h)).toEqual([ASKING, FAILED]);
      await h.clock.advance(30_000);
      expect(asks(h)).toBe(1);
      if (code === "unauthenticated") expect(h.spoken("notice")).toContain(LINES.pairAgain);
    });
  }

  it("GH18: an older server's 404: not sent failed, and GET /help waits 60 s while heartbeats go on", async () => {
    const h = harness();
    h.fake.helpRoutes = false;
    await boot(h);
    expect(statuses(h)).toBe(1);
    await chord(h);
    expect(helpLines(h)).toEqual([ASKING, FAILED]);
    await h.clock.advance(50_000);
    expect(statuses(h)).toBe(1);
    expect(h.client.calls.filter((c) => c === "heartbeat").length).toBeGreaterThan(8);
    await h.clock.advance(15_000);
    expect(statuses(h)).toBe(2);
  });

  it("GH19: not_sent shows 10 s, then the screen goes back", async () => {
    const h = await booted();
    h.fake.caretakers = [];
    await chord(h);
    await h.clock.advance(9_900);
    expect(h.last()).toBe("help not_sent no_caretaker");
    await h.clock.advance(200);
    expect(h.last()).toBe("none");
  });

  it("GH20: sent to more phones; open polls every 2 s and after heartbeats", async () => {
    const h = await booted();
    h.fake.caretakers = [MAYA, SAM];
    await chord(h);
    expect(helpLines(h)).toEqual([ASKING, "Sent to Maya and Sam's phones."]);
    const before = statuses(h);
    await h.clock.advance(10_000);
    expect(statuses(h) - before).toBeGreaterThanOrEqual(5);
  });

  it("GH21: a poll while sending finds it open (the POST's answer was lost): taken as the answer, no more tries", async () => {
    const h = await booted();
    h.client.late.add("help:ask");
    await chord(h);
    expect(h.last()).toBe("help sending");
    await h.clock.advance(2100);
    expect(h.last()).toBe("help open");
    expect(helpLines(h)).toEqual([ASKING, SENT]);
    h.client.releaseHeld();
    await h.clock.advance(10_000);
    expect(helpLines(h)).toEqual([ASKING, SENT]);
    expect(asks(h)).toBe(1);
  });

  it("GH22: each phone that shows it is said once, by member id (two Sams are two phones)", async () => {
    const h = await booted();
    h.fake.caretakers = [MAYA, SAM, SAM_TOO];
    await opened(h);
    const id = h.device()!.deviceId;
    h.fake.helpShownOn(id, "Maya");
    await h.clock.advance(2000);
    expect(helpLines(h).slice(2)).toEqual(["It's showing on Maya's phone."]);
    expect(h.last()).toBe("help open shown");
    await h.clock.advance(6000);
    expect(helpLines(h).slice(2)).toEqual(["It's showing on Maya's phone."]);
    const open = deviceHelp(h)[0]!;
    open.shown_to.push({ ...SAM }, { ...SAM_TOO });
    await h.clock.advance(2000);
    expect(helpLines(h).slice(2)).toEqual(["It's showing on Maya's phone.", "It's showing on Sam's phone.", "It's showing on Sam's phone."]);
  });

  it("GH23: each caretaker coming is said once; two new in one poll are one line", async () => {
    const h = await booted();
    h.fake.caretakers = [MAYA, SAM, { member_id: "00000000-0000-4000-8000-00000000ca04", name: "Lee" }];
    await opened(h);
    const id = h.device()!.deviceId;
    h.fake.helpComing(id, "Maya");
    await h.clock.advance(2000);
    const coming = () => helpLines(h).filter((l) => l.includes("on the way"));
    expect(coming()).toEqual(["Maya is on the way."]);
    expect(h.last()).toBe("help open shown coming");
    await h.clock.advance(6000);
    expect(coming()).toEqual(["Maya is on the way."]);
    h.fake.helpComing(id, "Sam");
    h.fake.helpComing(id, "Lee");
    await h.clock.advance(2000);
    expect(coming()).toEqual(["Maya is on the way.", "Sam and Lee are on the way."]);
  });

  it("GH24: a lone Confirm arms, a second within 30 s closes okay once; a press while it is answered sends nothing", async () => {
    const h = await booted();
    await opened(h);
    await lone(h);
    expect(helpLines(h).at(-1)).toBe("Press Confirm again to tell Maya you're okay.");
    expect(h.last()).toBe("help open confirm_okay");
    expect(okays(h)).toBe(0);
    h.client.hold.add("help:okay");
    await lone(h);
    await lone(h);
    await lone(h);
    expect(okays(h)).toBe(1);
    h.client.releaseHeld();
    await flush();
    expect(helpLines(h).at(-1)).toBe("Okay. Maya will see that you're okay.");
    expect(h.last()).toBe("help closed okay");
    await h.clock.advance(10_000);
    expect(h.last()).toBe("none");
  });

  it("GH25: armed and no second press for 30 s: disarmed; the next lone Confirm arms again", async () => {
    const h = await booted();
    await opened(h);
    await lone(h);
    await h.clock.advance(30_000);
    expect(h.last()).toBe("help open");
    await lone(h);
    expect(helpLines(h).filter((l) => l.startsWith("Press Confirm again"))).toHaveLength(2);
    expect(okays(h)).toBe(0);
  });

  it("GH26: /okay answered 409 help_closed: closed okay counts as success; with_her says who is with her", async () => {
    for (const how of ["okay", "with_her"] as const) {
      const h = await booted();
      await opened(h);
      h.client.hold.add("help:status");
      const id = h.device()!.deviceId;
      if (how === "okay") h.fake.closeHelp(id, "okay");
      else h.fake.helpWithHer(id, "Maya");
      await lone(h);
      await lone(h);
      expect(okays(h), how).toBe(1);
      expect(helpLines(h).at(-1), how).toBe(how === "okay" ? "Okay. Maya will see that you're okay." : "Maya says they're with you.");
      expect(h.last(), how).toBe(`help closed ${how}`);
    }
  });

  it("GH27: /okay doesn't get through: disarmed, said, still open", async () => {
    const h = await booted();
    await opened(h);
    await lone(h);
    h.client.network = "down";
    await lone(h);
    expect(helpLines(h).at(-1)).toBe("I couldn't reach the internet. Press Confirm twice to try again.");
    expect(h.last()).toBe("help open");
  });

  it("GH28: closed in a poll: each line once, shown 10 s, later polls say and show nothing", async () => {
    const cases = [
      { close: (h: H) => h.fake.helpWithHer(h.device()!.deviceId, "Maya"), line: "Maya says they're with you.", shown: "help closed with_her" },
      { close: (h: H) => h.fake.closeHelp(h.device()!.deviceId, "expired"), line: "Your request for help has ended.", shown: "help closed expired" },
      { close: (h: H) => h.fake.closeHelp(h.device()!.deviceId, "okay"), line: "Okay. Maya will see that you're okay.", shown: "help closed okay" },
    ];
    for (const { close, line, shown } of cases) {
      const h = await booted();
      await opened(h);
      close(h);
      await h.clock.advance(2000);
      expect(helpLines(h).at(-1), line).toBe(line);
      expect(h.last(), line).toBe(shown);
      await h.clock.advance(10_000);
      expect(h.last(), line).toBe("none");
      const said = helpLines(h).length;
      await h.clock.advance(30_000);
      expect(helpLines(h).length, line).toBe(said);
      expect(h.last(), line).toBe("none");
    }
  });

  it("GH29: a request made on her phone shows after a heartbeat; a closed one never seen open isn't", async () => {
    const h = await booted();
    h.fake.helpFromPhone(h.device()!.deviceId);
    await h.clock.advance(5000);
    expect(h.last()).toBe("help open");
    expect(helpLines(h)).toEqual([SENT]);

    const g = harness();
    g.fake.helpFromPhone(g.device()!.deviceId);
    g.fake.closeHelp(g.device()!.deviceId, "okay");
    await boot(g);
    await g.clock.advance(10_000);
    expect(g.helps).toEqual([]);
    expect(helpLines(g)).toEqual([]);
  });

  it("GH30: open, then gone from the server: back, nothing said, the 2 s polls stop", async () => {
    const h = await booted();
    await opened(h);
    h.device()!.help = [];
    await h.clock.advance(2000);
    expect(h.last()).toBe("none");
    const said = helpLines(h).length;
    const before = statuses(h);
    await h.clock.advance(10_000);
    expect(statuses(h) - before).toBeLessThanOrEqual(2);
    expect(helpLines(h).length).toBe(said);
  });

  it("GH33: help lines are logged by length on the Pi and never become heartbeat events", async () => {
    const h = harness();
    const log = captureLogger();
    attachLogging(h.bus, log, { replyText: false });
    await boot(h);
    await opened(h);
    await h.clock.advance(10_000);
    expect(log.lines.filter((l) => l.includes('kind="help"'))).not.toHaveLength(0);
    expect([...log.lines, ...h.log.lines].join("\n")).not.toContain("Maya");
    expect(JSON.stringify(h.device()!.events)).not.toContain("Maya");
    expect(JSON.stringify(h.device()!.events)).not.toContain(ASKING);
  });

  it("GH34: a 401 while open: help leaves the screen and its polling stops", async () => {
    const h = await booted();
    await opened(h);
    h.fake.forget(h.device()!.deviceId);
    await h.clock.advance(5000);
    expect(h.service.link).toBe("unauthorized");
    expect(h.last()).toBe("none");
    const before = statuses(h);
    await h.clock.advance(20_000);
    expect(statuses(h)).toBe(before);
  });

  it("GH35: a caretaker's message that arrives during the countdown is read once the request is sent", async () => {
    const h = await booted();
    await h.clock.advance(5000);
    h.fake.script = [{ reply: "unused", askForHelp: true }];
    await talk(h);
    h.fake.sendFromCaretaker(h.device()!.deviceId, "Maya", "Dinner at six.");
    await h.clock.advance(6000);
    expect(h.spoken("message")).toEqual([]);
    await h.clock.advance(6000);
    const spoken = h.spoken();
    expect(spoken.indexOf("Message from Maya. Dinner at six.")).toBeGreaterThan(spoken.indexOf(SENT));
  });

  it("GH36: the chord while sending: the hold shows, and nothing new is sent", async () => {
    const h = await booted();
    h.client.network = "down";
    await chord(h);
    const before = deviceHelp(h).length;
    await down(h);
    expect(h.last()).toBe("help_hold");
    await h.clock.advance(2000);
    await up(h);
    expect(helpLines(h).filter((l) => l === ASKING)).toHaveLength(1);
    h.client.network = "up";
    await h.clock.advance(5000);
    expect(deviceHelp(h).length - before).toBe(1);
    expect(deviceHelp(h)[0]!.clientIds.size).toBe(1);
  });
});

describe("help on the walker screen (the whole service)", () => {
  function screened(): H & { states: ScreenState[]; names: () => string[] } {
    const h = harness({ withTof: true });
    const states: ScreenState[] = [];
    const attached = attachScreen({
      bus: h.bus,
      clock: h.clock,
      log: h.log,
      service: h.service,
      modules: h.modules,
      simulator: true,
      settings: startingSettings(undefined, Date.parse("2026-10-24T02:00:00Z")),
      localTime: () => null,
      onState: (s) => states.push(s),
    });
    const start = h.service.start.bind(h.service);
    h.service.start = () => {
      start();
      seedScreen(attached.machine, h.service);
    };
    const names = () => states.map((s) => s.screen.state).filter((n, i, all) => n !== all[i - 1]);
    return Object.assign(h, { states, names });
  }

  it("GH31: an obstacle takes the screen from help, and help comes back after the tail", async () => {
    const h = screened();
    await boot(h);
    await opened(h);
    h.tof!.readings = { front_left: { mm: 300 }, front_right: { mm: 1500 } };
    await h.clock.advance(500);
    expect(h.states.at(-1)!.screen.state).toBe("obstacle");
    h.tof!.readings = { front_left: { mm: 1500 }, front_right: { mm: 1500 } };
    await h.clock.advance(1500);
    expect(h.states.at(-1)!.screen.state).toBe("help");
  });

  it("GH32: a Talk turn while open: listening, One moment, the answer, then help again", async () => {
    const h = screened();
    await boot(h);
    await opened(h);
    h.fake.script = [{ reply: "Fake cloud: Maya's phone shows it." }];
    const from = h.states.length;
    await talk(h);
    await h.clock.advance(10_000);
    const after = h.states.slice(from).map((s) => s.screen.state).filter((n, i, all) => n !== all[i - 1]);
    expect(after).toEqual(["listening", "thinking", "answering", "help"]);
    expect(h.bodies.at(-1)!.can_ask_for_help).toBe(true);
  });

  it("GS2/GS3: the countdown drops the answer at once and ticks one state a second", async () => {
    const h = screened();
    await boot(h);
    h.fake.script = [{ reply: "unused", askForHelp: true }];
    const from = h.states.length;
    await talk(h);
    expect(h.states.at(-1)!.screen).toEqual({ state: "help_countdown", seconds_left: 8 });
    await h.clock.advance(3000);
    const counted = h.states.slice(from).filter((s) => s.screen.state === "help_countdown").map((s) => (s.screen as { seconds_left: number }).seconds_left);
    expect(counted).toEqual([8, 7, 6, 5]);
  });
});
