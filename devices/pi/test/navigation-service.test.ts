import { describe, expect, it, vi } from "vitest";
import { RouteSummarySchema, SHARED_ROUTE_POINTS, type LatLon, type WalkerToolCall } from "@walker/contracts";
import { CloudError } from "../src/cloud/client";
import { GpsSampler, type GpsResult } from "../src/gps";
import { attachLogging } from "../src/logging";
import { NAV_LINES } from "../src/navigation/navigator";
import { injectedMapServices, type MapFetch } from "../src/navigation/osm";
import type { PositionSource } from "../src/navigation/position";
import { SIMULATED_START, SimulatedPosition } from "../src/navigation/simulated";
import { recordedMapFetch, recordedMapServices } from "../src/sim/fakeMaps";
import { LINES } from "../src/notices";
import { boot, captureLogger, flush, makeHarness, type Harness } from "./support/fakes";

/**
 * Rows N8, N14, N15 and N17 to N26 of test/EXPECTED.md ("Walking directions"): the route tools in the service's
 * turn loop, guidance in the walker's voice, Confirm and the screen's presses, and the privacy rows. Fake clock,
 * fake cloud (which scripts the tool calls), the SIMULATED position and the recorded map services.
 */

const INTRO = "On the simulated position: Walking to the Lake Merritt Boating Center, about 750 meters. Head west on the path. Directions come from OpenStreetMap and may include steps or curbs.";

/** A walker with the simulated position (or `source`) and the recorded map services (or `fetch`). */
function walker(options: { source?: (clock: Harness["clock"]) => PositionSource; fetch?: MapFetch; logging?: boolean } = {}) {
  const h = makeHarness({
    location: (clock, log) => (options.source ? options.source(clock) : new SimulatedPosition(clock, log, { speedup: 3 })),
    maps: (clock) => (options.fetch ? injectedMapServices(clock, options.fetch) : recordedMapServices(clock)),
  });
  if (options.logging) attachLogging(h.bus, h.log, { replyText: false });
  return Object.assign(h, { position: h.location as SimulatedPosition });
}

type Walker = ReturnType<typeof walker>;

/** Holds Talk (GPIO) for a second with the fake cloud's next answer scripted to ask for `tool`, and lets it finish. */
async function ask(h: Walker, tool: WalkerToolCall, holdMs = 1000): Promise<void> {
  h.fake.script.push({ reply: "Fake cloud: let me find that.", tool });
  h.press("talk", "pressed");
  await h.clock.advance(holdMs);
  h.press("talk", "released");
  // Long enough for the shared Nominatim limiter (1.1 s between requests).
  await h.clock.advance(1200);
  await flush();
}

const START_ROUTE: WalkerToolCall = { name: "start_route", destination: "Lake Merritt Boating Center" };
const views = (h: Walker) => h.named("navigation").map((n) => n.view);
const guidance = (h: Walker) => h.spoken("guidance");
const lastRequest = (h: Walker) => h.device()!.turnRequests.at(-1)!;

describe("start_route and stop_route in the turn loop", () => {
  it("N8/N14: a spoken turn starts the route; the reply, then the Pi's own first line", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    const result = lastRequest(h).tool_results!.at(-1)!;
    expect(result.name).toBe("start_route");
    expect(result.text).toBe(
      "Walking directions started to Lake Merritt Boating Center: about 750 meters, around 11 minutes on foot. First: Head west on the path. The walker says each turn itself. Directions come from OpenStreetMap and may include steps or curbs. This uses the walker's simulated position, not a real GPS fix.",
    );
    const spoken = h.spoken();
    const reply = spoken.indexOf(`Fake cloud: ${result.text}`);
    expect(reply).toBeGreaterThan(-1);
    expect(spoken.indexOf(INTRO)).toBeGreaterThan(reply);
    expect(guidance(h)[0]).toBe(INTRO);
    expect(views(h).at(-1)).toMatchObject({ state: "navigating", phase: "guiding", destination: "Lake Merritt Boating Center", simulated: true });
  });

  it("N14: the first line waits while the reply plays", async () => {
    const h = walker();
    await boot(h);
    h.speaker.hold = true;
    await ask(h, START_ROUTE);
    await h.clock.advance(0);
    expect(guidance(h)).toEqual([]);
    for (let i = 0; i < 4; i += 1) {
      h.speaker.finish();
      await flush();
    }
    expect(guidance(h)[0]).toBe(INTRO);
  });

  it("N14: a turn that fails after the route started still says the first line, after the failure line", async () => {
    const h = walker();
    await boot(h);
    const client = h.client;
    const original = client.turn.bind(client);
    let calls = 0;
    client.turn = (body, signal) => (++calls === 2 ? Promise.reject(new CloudError("server_error", "Server error 500.", 500)) : original(body, signal));
    await ask(h, START_ROUTE);
    const spoken = h.spoken();
    expect(spoken.indexOf(LINES.serverTrouble)).toBeGreaterThan(-1);
    expect(spoken.indexOf(INTRO)).toBeGreaterThan(spoken.indexOf(LINES.serverTrouble));
    expect(guidance(h)).toContain(INTRO);
  });

  it("N8: each failure is a fixed line and leaves no route on", async () => {
    const cases: Array<{ name: string; make: () => Walker; tool?: WalkerToolCall; text: string | RegExp }> = [
      { name: "not found", make: () => walker(), tool: { name: "start_route", destination: "the Moon Base" }, text: 'I couldn\'t find "the Moon Base" near you.' },
      {
        name: "too far",
        make: () => walker({ source: (clock) => new SimulatedPosition(clock, captureLogger(), { start: [37.87, -122.2575] }) }),
        text: "That's about 7.2 kilometers, farther than I can guide on foot.",
      },
      { name: "a map error", make: () => walker({ fetch: () => Promise.resolve(new Response("{}", { status: 500 })) }), text: "I couldn't plan a route right now." },
      {
        name: "no route",
        make: () => walker({ fetch: (url, init) => (url.pathname.includes("/route/") ? Promise.resolve(new Response(JSON.stringify({ code: "NoRoute" }))) : recordedMapFetch(url, init)) }),
        text: "I found Lake Merritt Boating Center, but couldn't find a walking route there.",
      },
      { name: "no fix", make: () => walker({ source: () => stubSource({ onDemand: () => Promise.resolve({ status: "no_fix" }) }) }), text: /no satellite fix yet/ },
      { name: "not connected", make: () => walker({ source: () => stubSource({ connected: () => false }) }), text: "I can't give walking directions because the GPS receiver is not connected." },
      { name: "past 12 s", make: () => walker({ source: () => stubSource({ onDemand: () => new Promise(() => {}) }) }), text: "I couldn't plan a route in time. Please try again in a moment." },
    ];
    for (const c of cases) {
      const h = c.make();
      await boot(h);
      h.fake.script.push({ reply: "Fake cloud: let me find that.", tool: c.tool ?? START_ROUTE });
      h.press("talk", "pressed");
      await h.clock.advance(1000);
      h.press("talk", "released");
      await h.clock.advance(c.name === "past 12 s" ? 12_000 : 0);
      await flush();
      const result = lastRequest(h).tool_results?.at(-1)?.text;
      if (typeof c.text === "string") expect(result, c.name).toBe(c.text);
      else expect(result, c.name).toMatch(c.text);
      expect(lastRequest(h).navigation, c.name).toEqual({ route: null });
      expect(guidance(h), c.name).toEqual([]);
    }
  });

  it("N17: every device turn and continuation carries navigation; without a position source, none", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    const [first, continuation] = h.device()!.turnRequests;
    expect(first!.navigation).toEqual({ route: null });
    const route = continuation!.navigation!.route!;
    expect(RouteSummarySchema.safeParse(route).success).toBe(true);
    expect(route).toMatchObject({ destination: "Lake Merritt Boating Center", phase: "guiding", next: "Turn left onto Lenox Avenue.", simulated: true });
    expect(route.remaining_min).toBe(11);
    // "How far is it?": the next turn carries the route in progress.
    h.fake.script.push({ reply: "Fake cloud: about 700 meters." });
    h.press("talk", "pressed");
    await h.clock.advance(5000);
    h.press("talk", "released");
    await flush();
    const later = lastRequest(h).navigation!.route!;
    expect(later.remaining_m).toBeLessThan(route.remaining_m);
    const bare = makeHarness();
    await boot(bare);
    bare.press("talk", "pressed");
    await bare.clock.advance(1000);
    bare.press("talk", "released");
    await flush();
    expect("navigation" in bare.device()!.turnRequests.at(-1)!).toBe(false);
  });

  it("N28: the simulated position stands still until she has heard the route's first line", async () => {
    const h = walker();
    await boot(h);
    h.speaker.hold = true;
    await ask(h, START_ROUTE);
    const before = h.position.current();
    await h.clock.advance(20_000);
    expect(guidance(h)).toEqual([]);
    expect(h.position.current()).toMatchObject({ latitude: before.latitude, longitude: before.longitude });
    for (let i = 0; i < 6 && !guidance(h).includes(INTRO); i += 1) {
      h.speaker.finish();
      await flush();
    }
    expect(guidance(h)[0]).toBe(INTRO);
    h.speaker.hold = false;
    h.speaker.finish();
    await flush();
    await h.clock.advance(5_000);
    expect(h.position.current().latitude).not.toBe(before.latitude);
  });

  it("N29: a Talk press that cancels the turn after start_route ran ends that route; its first line is never said", async () => {
    const h = walker();
    await boot(h);
    const client = h.client;
    const original = client.turn.bind(client);
    let calls = 0;
    // The continuation after start_route never answers, so the turn is still waiting when she presses Talk.
    client.turn = (body, signal) => (++calls === 2 ? new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })) : original(body, signal));
    await ask(h, START_ROUTE);
    expect(views(h).at(-1)).toMatchObject({ state: "navigating" });
    h.press("talk", "pressed");
    await flush();
    expect(views(h).at(-1)).toBeNull();
    await h.clock.advance(5_000);
    expect(guidance(h)).not.toContain(INTRO);
    expect(h.spoken()).toContain(LINES.cancelled);
  });

  it("N31: guidance waits while she holds both handles to ask for help, and comes after she lets go", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    await h.clock.advance(1_000);
    expect(guidance(h)[0]).toBe(INTRO);
    h.position.pause();
    const before = guidance(h).length;
    h.press("talk", "pressed");
    await flush();
    h.press("confirm", "pressed");
    await flush();
    h.position.walk(20);
    await h.clock.advance(1_500);
    expect(guidance(h).length).toBe(before);
    h.press("talk", "released");
    h.press("confirm", "released");
    await flush();
    await h.clock.advance(1_000);
    expect(guidance(h).slice(before).some((line) => line.includes("Lenox Avenue"))).toBe(true);
  });

  it("N18: stop_route ends the route; with none it says so; a second start_route replaces the first", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    await ask(h, START_ROUTE);
    expect(guidance(h).filter((g) => g === INTRO)).toHaveLength(2);
    await h.clock.advance(5000);
    await ask(h, { name: "stop_route" });
    expect(lastRequest(h).tool_results!.at(-1)!.text).toBe("Stopped the directions to the Lake Merritt Boating Center.");
    expect(views(h).at(-1)).toBeNull();
    const still = h.position.current();
    await h.clock.advance(10_000);
    expect(h.position.current()).toEqual(still);
    await ask(h, { name: "stop_route" });
    expect(lastRequest(h).tool_results!.at(-1)!.text).toBe("There were no walking directions to stop.");
    expect(lastRequest(h).navigation).toEqual({ route: null });
  });
});

function stubSource(over: Partial<PositionSource>): PositionSource {
  return {
    simulated: false,
    connected: () => true,
    setEnabled: () => {},
    track: () => {},
    current: () => null,
    onDemand: (): Promise<GpsResult> => Promise.resolve({ status: "fix", latitude: SIMULATED_START[0], longitude: SIMULATED_START[1] }),
    stop: () => {},
    ...over,
  };
}

describe("guidance in the walker's voice", () => {
  it("N15: guidance waits while Talk is held; the newest line replaces older ones, and a passed step's line is dropped", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    const before = guidance(h).length;
    // Hold Talk for 12 s (under the 15 s clip limit): the simulated walk (3.6 m/s) comes within 40 m of the Lenox
    // Avenue turn and then within 8 m of it meanwhile.
    h.fake.script.push({ reply: "Fake cloud: sure." });
    h.press("talk", "pressed");
    await h.clock.advance(12_000);
    expect(guidance(h).length).toBe(before);
    h.press("talk", "released");
    await flush();
    await h.clock.advance(0);
    const after = guidance(h).slice(before);
    expect(after).toEqual(["Turn left now."]);
    expect(after).not.toContain("In 40 meters, turn left onto Lenox Avenue.");
    expect(after).not.toContain("In 30 meters, turn left onto Lenox Avenue.");
    const spoken = h.spoken();
    expect(spoken.indexOf("Fake cloud: sure.")).toBeLessThan(spoken.lastIndexOf(after[0] ?? "Fake cloud: sure."));
  });

  it("N22: offline mid-route, guidance keeps going; tracking stays on", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    h.client.network = "down";
    await h.clock.advance(10_000);
    expect(h.service.link).toBe("offline");
    const before = guidance(h).length;
    await h.clock.advance(60_000);
    expect(guidance(h).length).toBeGreaterThan(before);
    expect(guidance(h).some((g) => g.endsWith(" now."))).toBe(true);
  });

  it("N13 (in the service): the arrival is said, and the route ends 20 s later", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    // 773 m at 3.6 m/s is about 215 s.
    await h.clock.advance(240_000);
    expect(guidance(h)).toContain("You've arrived near the Lake Merritt Boating Center.");
    await h.clock.advance(25_000);
    expect(views(h).at(-1)).toBeNull();
  });
});

describe("Confirm and the screen's presses during a route", () => {
  it("N19: with a route on and nothing to confirm, Confirm says the next instruction again (offline too)", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    const before = guidance(h).length;
    h.press("confirm");
    await flush();
    expect(guidance(h).slice(before)).toEqual([expect.stringMatching(/^In \d+ meters, turn left onto Lenox Avenue\.$/)]);
    expect(h.speaker.cues).not.toContain("nothing_to_confirm");
    h.client.network = "down";
    await h.clock.advance(10_000);
    expect(h.service.link).toBe("offline");
    const offline = guidance(h).length;
    h.press("confirm");
    await flush();
    expect(guidance(h).length).toBe(offline + 1);
  });

  it("N19: a message on screen is read again first; after its 20 s hold, Confirm repeats the direction", async () => {
    const h = walker();
    await boot(h);
    await h.clock.advance(5000);
    await ask(h, START_ROUTE);
    h.fake.sendFromCaretaker(h.device()!.deviceId, "Maya", "Dinner at six.");
    await h.clock.advance(5000);
    await flush();
    expect(h.spoken("message")).toEqual(["Message from Maya. Dinner at six."]);
    h.press("confirm");
    await flush();
    expect(h.spoken("message")).toHaveLength(2);
    await h.clock.advance(21_000);
    const before = guidance(h).length;
    h.press("confirm");
    await flush();
    expect(h.spoken("message")).toHaveLength(2);
    expect(guidance(h).length).toBe(before + 1);
  });

  it("N20: End route and Repeat act only when drawn on the route's screen", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    const before = guidance(h).length;
    h.bus.emit("screenPress", { action: "repeat_direction", revision: 7, state: "ambient" });
    h.bus.emit("screenPress", { action: "end_route", revision: 7, state: "answering" });
    await flush();
    expect(guidance(h).length).toBe(before);
    expect(views(h).at(-1)).not.toBeNull();
    h.bus.emit("screenPress", { action: "repeat_direction", revision: 8, state: "navigating" });
    await flush();
    expect(guidance(h).length).toBe(before + 1);
    h.bus.emit("screenPress", { action: "end_route", revision: 9, state: "navigating" });
    await flush();
    expect(views(h).at(-1)).toBeNull();
    expect(guidance(h).at(-1)).toBe("Directions stopped.");
    h.bus.emit("screenPress", { action: "repeat_direction", revision: 10, state: "navigating" });
    await flush();
    expect(guidance(h).at(-1)).toBe("Directions stopped.");
  });

  it("N21: Talk doesn't end the route; Forget (401) and service stop do", async () => {
    const h = walker();
    await boot(h);
    await ask(h, START_ROUTE);
    h.fake.script.push({ reply: "Fake cloud: sure." });
    h.press("talk", "pressed");
    await h.clock.advance(1000);
    h.press("talk", "released");
    await flush();
    expect(views(h).at(-1)).not.toBeNull();
    h.fake.forget(h.device()!.deviceId);
    await h.clock.advance(6000);
    expect(h.service.link).toBe("unauthorized");
    expect(views(h).at(-1)).toBeNull();
    const again = walker();
    await boot(again);
    await ask(again, START_ROUTE);
    again.service.stop();
    expect(views(again).at(-1)).toBeNull();
  });
});

describe("position sources", () => {
  it("N23: the GPS sampler keeps sharing and tracking apart, and samples about every second while tracking", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    try {
      const reads: number[] = [];
      const sampler = new GpsSampler("/dev/null-gps", 9600, () => {}, (_port, _baud, waitMs) => {
        reads.push(waitMs);
        return Promise.resolve({ status: "fix", latitude: 37.8, longitude: -122.25 });
      });
      expect(sampler.current()).toBeNull();
      sampler.setEnabled(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(sampler.current()).not.toBeNull();
      await vi.advanceTimersByTimeAsync(4_900);
      expect(reads).toEqual([4000]);
      sampler.track(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reads.length).toBeGreaterThanOrEqual(4);
      expect(reads.at(-1)).toBe(2000);
      // Sharing off (offline): tracking keeps the fix and the sampling.
      sampler.setEnabled(false);
      const count = reads.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reads.length).toBeGreaterThan(count);
      expect(sampler.current()).not.toBeNull();
      sampler.track(false);
      expect(sampler.current()).toBeNull();
      const stopped = reads.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reads.length).toBe(stopped);
    } finally {
      vi.useRealTimers();
    }
  });

  it("N24: the simulated position starts by Lake Merritt, walks the route, and obeys the script commands", async () => {
    const h = walker();
    expect(h.position.current()).toMatchObject({ latitude: 37.8098, longitude: -122.2575, age_ms: 0 });
    await boot(h);
    const part = h.service.manifest().modules.find((m) => m.module_id === "location.gps");
    expect(part).toMatchObject({ instance_id: "simulated-gps", simulated: true });
    await ask(h, { name: "get_location" });
    expect(h.spoken()).toContain("Fake cloud: Your simulated GPS puts you near 451 Lee Street, Oakland, California.");
    await ask(h, START_ROUTE);
    const at = (h: Walker): LatLon => [h.position.current().latitude, h.position.current().longitude];
    const first = at(h);
    await h.clock.advance(10_000);
    const moved = at(h);
    const metres = Math.hypot((moved[0] - first[0]) * 111_320, (moved[1] - first[1]) * 111_320 * Math.cos((first[0] * Math.PI) / 180));
    expect(metres).toBeGreaterThan(30);
    expect(metres).toBeLessThan(40);
    h.position.pause();
    const paused = at(h);
    await h.clock.advance(5000);
    expect(at(h)).toEqual(paused);
    h.position.resume();
    h.position.walk(100);
    await h.clock.advance(0);
    expect(at(h)).not.toEqual(paused);
    h.position.offRoute(50);
    const off = at(h);
    await h.clock.advance(1500);
    expect(at(h)).toEqual(off);
    await h.clock.advance(3000);
    expect(guidance(h)).toContain(NAV_LINES.offRoute);
    h.position.at(37.81, -122.26);
    expect(at(h)).toEqual([37.81, -122.26]);
  });
});

describe("privacy", () => {
  it("N25: no guidance line is a walker line; a shared heartbeat marks a simulated position and carries the route, and nothing goes unshared", async () => {
    const h = walker();
    h.fake.locationSharing = true;
    await boot(h);
    await ask(h, START_ROUTE);
    await h.clock.advance(60_000);
    expect(guidance(h).length).toBeGreaterThan(3);
    const lines = JSON.stringify([h.device()!.events, h.store.pendingEvents(h.clock.monotonic())]);
    for (const line of guidance(h)) expect(lines).not.toContain(line);
    const beat = h.device()!.lastHeartbeat!;
    expect(beat.location?.simulated).toBe(true);
    expect(beat.route).toMatchObject({ destination: "Lake Merritt Boating Center", phase: "guiding", simulated: true });
    expect(beat.route!.ahead.length).toBeGreaterThanOrEqual(2);
    expect(beat.route!.ahead.length).toBeLessThanOrEqual(SHARED_ROUTE_POINTS);
    // Sharing off: no fix and no route, even mid-route.
    h.fake.locationSharing = false;
    await h.clock.advance(20_000);
    expect(h.device()!.lastHeartbeat!.location).toBeUndefined();
    expect(h.device()!.lastHeartbeat!.route).toBeUndefined();
    // A real receiver's fix still goes, with sharing on.
    const real = walker({ source: () => stubSource({ current: () => ({ latitude: 37.8, longitude: -122.25, age_ms: 100 }) }) });
    real.fake.locationSharing = true;
    await boot(real);
    await real.clock.advance(10_000);
    expect(real.device()!.lastHeartbeat!.location).toEqual({ latitude: 37.8, longitude: -122.25, age_ms: 100 });
  });

  it("N26: no coordinate in any turn request or log line; no place or street name in a log line", async () => {
    const h = walker({ logging: true });
    await boot(h);
    await ask(h, { name: "get_location" });
    await ask(h, START_ROUTE);
    h.position.offRoute(50);
    await h.clock.advance(60_000);
    await ask(h, { name: "stop_route" });
    await ask(h, START_ROUTE);
    await h.clock.advance(300_000);
    expect(guidance(h)).toContain("You've arrived near the Lake Merritt Boating Center.");
    const requests = JSON.stringify(h.device()!.turnRequests);
    expect(h.device()!.turnRequests.length).toBeGreaterThan(6);
    expect(requests).toContain("Lake Merritt Boating Center");
    const logs = h.log.lines.join("\n");
    expect(logs).toContain("route started");
    for (const text of [requests, logs]) {
      expect(text).not.toMatch(/37\.8\d/);
      expect(text).not.toMatch(/122\.2\d/);
    }
    for (const name of ["Boating", "Lenox", "Lee Street", "the path", "Walking to"]) expect(logs).not.toContain(name);
    expect(logs).toMatch(/speak kind="guidance" text="\(\d+ characters\)"/);
  });
});
