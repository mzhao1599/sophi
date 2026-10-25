import { describe, expect, it } from "vitest";
import { SerialHapticPlaySchema } from "@walker/contracts";
import { Bus } from "../src/bus";
import { CloudError } from "../src/cloud/client";
import { CONFIRM_PRESS_HAPTIC_MS, MESSAGES_RETRY_MS } from "../src/constants";
import { attachLogging } from "../src/logging";
import { LINES } from "../src/notices";
import { messageLine } from "../src/service";
import { boot, captureLogger, flush, makeHarness, pairInto, type Harness } from "./support/fakes";

/** Rows CM1 to CM12 of test/EXPECTED.md ("Her messages"). Every time comes from a fake clock. */

const DINNER = "Dinner at six. I'll get you.";
const DINNER_LINE = "Message from Maya. Dinner at six. I'll get you.";

/** A (fake) caretaker's message to her phone, as the server would hold it. */
function send(h: Harness, text = DINNER, from = "Maya") {
  return h.fake.sendFromCaretaker(h.device()!.deviceId, from, text);
}

/** One heartbeat tick, and the messages fetch that follows it. */
async function tick(h: Harness): Promise<void> {
  await h.clock.advance(5000);
  await flush();
}

const messages = (h: Harness) => h.spoken("message");
const fetches = (h: Harness) => h.client.calls.filter((c) => c === "messages").length;

describe("her messages: read aloud by the walker", () => {
  it("CM1: messages already there at the first answer are not read out, and Confirm reads the newest", async () => {
    const h = makeHarness();
    send(h, "Old note");
    send(h, "Newer note");
    await boot(h);
    await tick(h);
    expect(fetches(h)).toBeGreaterThan(0);
    expect(messages(h)).toEqual([]);
    h.press("confirm");
    await flush();
    expect(messages(h)).toEqual(["Message from Maya. Newer note"]);
    expect(h.speaker.cues).not.toContain("nothing_to_confirm");
  });

  it("CM2/CM3: a new message is spoken once in the walker's own voice, and never reaches the page or a request", async () => {
    const h = makeHarness();
    await boot(h);
    await tick(h);
    send(h);
    await tick(h);
    expect(messages(h)).toEqual([DINNER_LINE]);
    expect(h.speaker.spoken).toContain(DINNER_LINE);
    await tick(h);
    await tick(h);
    expect(messages(h)).toEqual([DINNER_LINE]);
    // No heartbeat event carries the words, and nothing else was asked of the cloud.
    expect(JSON.stringify(h.device()!.events)).not.toContain("Dinner");
    expect(JSON.stringify(h.store.pendingEvents(h.clock.monotonic()))).not.toContain("Dinner");
    expect(h.client.calls.filter((c) => c !== "heartbeat" && c !== "messages")).toEqual([]);
  });

  it("CM4: a message that arrives while Talk is held waits until after the reply", async () => {
    const h = makeHarness();
    await boot(h);
    await tick(h);
    h.fake.script = [{ reply: "Fake cloud: it's sunny." }];
    h.press("talk", "pressed");
    await flush();
    send(h);
    await h.clock.advance(5000);
    await flush();
    expect(messages(h)).toEqual([]);
    h.press("talk", "released");
    await flush();
    await flush();
    const spoken = h.spoken();
    expect(spoken.indexOf(DINNER_LINE)).toBeGreaterThan(spoken.indexOf("Fake cloud: it's sunny."));
    expect(messages(h)).toEqual([DINNER_LINE]);
  });

  it("CM5: a message waits while a spoken message draft waits for Confirm, then is read once it's past its 30 s", async () => {
    const h = makeHarness();
    await boot(h);
    await tick(h);
    h.fake.script = [{ reply: "Send Maya: On my way? Press Confirm to send it.", offerMessage: { to_name: "Maya", text: "On my way" } }];
    h.press("talk", "pressed");
    await h.clock.advance(2000);
    h.press("talk", "released");
    await flush();
    send(h);
    await tick(h);
    await tick(h);
    expect(messages(h)).toEqual([]);
    await h.clock.advance(30_000);
    await flush();
    expect(messages(h)).toEqual([DINNER_LINE]);
  });

  it("CM6: Confirm with nothing to confirm reads the newest message again, offline too, with no request", async () => {
    const h = makeHarness();
    await boot(h);
    await tick(h);
    send(h);
    await tick(h);
    const answersBefore = h.client.calls.filter((c) => c.startsWith("answer")).length;
    h.press("confirm");
    await flush();
    expect(messages(h)).toEqual([DINNER_LINE, DINNER_LINE]);
    h.client.network = "down";
    await h.clock.advance(10_000);
    expect(h.service.link).toBe("offline");
    h.press("confirm");
    await flush();
    expect(messages(h)).toEqual([DINNER_LINE, DINNER_LINE, DINNER_LINE]);
    expect(h.client.calls.filter((c) => c.startsWith("answer")).length).toBe(answersBefore);
    expect(h.speaker.cues).not.toContain("nothing_to_confirm");
  });

  it("CM6: a press while a message is being read does nothing more; a hand press buzzes confirmation", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    await tick(h);
    h.speaker.hold = true;
    send(h);
    await tick(h);
    expect(messages(h)).toEqual([DINNER_LINE]);
    h.hand!.press("confirm", "pressed");
    await flush();
    h.speaker.finish();
    await flush();
    expect(messages(h)).toEqual([DINNER_LINE]);
    const buzzes = h.hand!.port.received
      .map((line) => JSON.parse(line) as { type: string })
      .filter((m) => m.type === "haptic.play")
      .map((m) => SerialHapticPlaySchema.parse(m))
      .map((m) => `${m.pattern} ${m.duration_ms}`);
    expect(buzzes).toEqual([`confirmation ${CONFIRM_PRESS_HAPTIC_MS}`]);
  });

  it("CM7: with an open proposal, Confirm answers it and reads no message", async () => {
    const h = makeHarness();
    await boot(h);
    await tick(h);
    send(h);
    await tick(h);
    h.fake.script = [{ reply: "Fake cloud: switch to short sounds? Press Confirm to do it.", proposeCues: ["sound"] }];
    h.press("talk", "pressed");
    await h.clock.advance(2000);
    h.press("talk", "released");
    await flush();
    expect(h.service.openProposal).not.toBeNull();
    h.press("confirm");
    await h.clock.advance(1000);
    expect(h.client.calls.filter((c) => c === "answer:confirm")).toHaveLength(1);
    expect(messages(h)).toEqual([DINNER_LINE]);
  });

  it("CM8: a message the server deleted is not read if still waiting, and not heard again", async () => {
    const h = makeHarness();
    await boot(h);
    await tick(h);
    h.press("talk", "pressed");
    await flush();
    const sent = send(h);
    await h.clock.advance(5000);
    await flush();
    h.fake.deleteMessage(h.device()!.deviceId, sent.message_id);
    await h.clock.advance(5000);
    await flush();
    h.press("talk", "released");
    await flush();
    await tick(h);
    expect(messages(h)).toEqual([]);
    h.press("confirm");
    await flush();
    expect(messages(h)).toEqual([]);
    expect(h.speaker.cues).toContain("nothing_to_confirm");
  });

  it("CM8: a message heard and then deleted can't be heard again", async () => {
    const h = makeHarness();
    await boot(h);
    await tick(h);
    const sent = send(h);
    await tick(h);
    h.fake.deleteMessage(h.device()!.deviceId, sent.message_id);
    await tick(h);
    h.press("confirm");
    await flush();
    expect(messages(h)).toEqual([DINNER_LINE]);
    expect(h.speaker.cues).toContain("nothing_to_confirm");
  });

  it("CM9: an older server with no messages route gets one warning and a minute's wait; the walker carries on", async () => {
    const h = makeHarness();
    await boot(h);
    let asked = 0;
    h.client.incomingMessages = () => {
      asked += 1;
      return Promise.reject(new CloudError("rejected", "Not found.", 404, "not_found"));
    };
    await tick(h);
    await tick(h);
    await tick(h);
    expect(asked).toBe(1);
    expect(h.log.lines.filter((l) => l.includes("couldn't fetch messages"))).toHaveLength(1);
    expect(h.service.link).toBe("online");
    await h.clock.advance(MESSAGES_RETRY_MS);
    await flush();
    expect(asked).toBe(2);
    h.press("confirm");
    await flush();
    expect(h.speaker.cues).toContain("nothing_to_confirm");
  });

  it("CM9: a network failure is left to the heartbeat: no warning, no minute's wait", async () => {
    const h = makeHarness();
    await boot(h);
    let asked = 0;
    h.client.incomingMessages = () => {
      asked += 1;
      return Promise.reject(new CloudError("unreachable", "fetch failed"));
    };
    await tick(h);
    await tick(h);
    expect(asked).toBe(2);
    expect(h.log.lines.filter((l) => l.includes("couldn't fetch messages"))).toEqual([]);
  });

  it("CM10: a 401 forgets every message; a walker paired again starts fresh", async () => {
    const h = makeHarness();
    await boot(h);
    await tick(h);
    send(h);
    await tick(h);
    expect(messages(h)).toEqual([DINNER_LINE]);
    h.fake.forget(h.device()!.deviceId);
    await tick(h);
    expect(h.service.link).toBe("unauthorized");
    h.press("confirm");
    await flush();
    expect(messages(h)).toEqual([DINNER_LINE]);
    expect(h.spoken("local_reply")).toContain(LINES.pairAgain);
    // Paired again: what that walker already holds is not read out (CM1).
    pairInto(h.fake, h.store);
    send(h, "Hello from the new walker's circle");
    await tick(h);
    await tick(h);
    expect(messages(h)).toEqual([DINNER_LINE]);
  });

  it("CM11: Talk while a message is read stops it and listens; Confirm reads it again afterwards", async () => {
    const h = makeHarness();
    await boot(h);
    await tick(h);
    h.speaker.hold = true;
    send(h);
    await tick(h);
    expect(messages(h)).toEqual([DINNER_LINE]);
    h.press("talk", "pressed");
    await flush();
    expect(h.speaker.stopped).toContain(DINNER_LINE);
    expect(h.service.talk).toBe("recording");
    h.speaker.hold = false;
    h.speaker.finish();
    await h.clock.advance(2000);
    h.press("talk", "released");
    await flush();
    await flush();
    h.press("confirm");
    await flush();
    expect(messages(h)).toEqual([DINNER_LINE, DINNER_LINE]);
  });

  it("CM12: a message line is logged by length only on the Pi", () => {
    const bus = new Bus();
    const log = captureLogger();
    attachLogging(bus, log, { replyText: false });
    bus.emit("spoke", { text: DINNER_LINE, kind: "message" });
    expect(log.lines.join("\n")).not.toContain("Dinner");
    expect(log.lines.join("\n")).toContain(`(${DINNER_LINE.length} characters)`);
  });

  it("reads who it is from, then the words exactly", () => {
    expect(messageLine({ from_name: "Maya", text: DINNER })).toBe(DINNER_LINE);
  });
});
