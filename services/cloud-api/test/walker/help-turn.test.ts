import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WalkerTurnResponseSchema, type DeviceTurnRequest, type WalkerTurnResponse } from "@walker/contracts";
import { CircleService, WALKER_SYSTEM_PROMPT, WalkerService, createWalkerAssistant, type AgentModel, type AgentRequest, type DeviceCaller, type MemberCaller, type OwnerCaller, type TurnEvent, type WalkerStore } from "../../src";
import { WALKER_REPLY_JSON_SCHEMA, WALKER_REPLY_JSON_SCHEMA_WITH_HELP } from "../../src/walker/assistant";
import { Clock, SKIP_POSTGRES, manifest, memoryHarness, postgresHarness, snapshot, uuid, walkerTestDatabaseUrl, type StoreHarness } from "./support";

/** The voice path for asking for help (EXPECTED-help.md, V1 to V8) with a stub model, against memory and Postgres. */

type Reply = { transcript?: string; reply: string; topics?: string[]; tool_call?: unknown };

function stubModel(answer: Reply) {
  const requests: AgentRequest[] = [];
  const model: AgentModel = {
    async generate(request) {
      requests.push(request);
      return { stop_reason: "end_turn", text: JSON.stringify({ transcript: "", topics: [], cues_change: null, tool_call: null, ...answer }) };
    },
  };
  return { model, requests };
}

const owner = (secret: string): OwnerCaller => ({ kind: "owner", secret });
const phone = (secret: string): MemberCaller => ({ kind: "member", secret });
const device = (credential: string): DeviceCaller => ({ kind: "device", credential });
const HELP_CALL: Reply = { reply: "I've told Maya.", tool_call: { name: "ask_for_help" } };
const COUNTDOWN = "I'll ask Maya and Ana for help in 8 seconds. Press any button to stop.";
const NO_CARETAKER = "No caretaker's phone is linked to this walker, so I can't ask anyone. If you need help now, call 911 from your phone.";

function describeHelpTurns(name: string, makeHarness: () => Promise<StoreHarness>) {
  describe(`help by voice: ${name}`, () => {
    let h: StoreHarness;
    let clock: Clock;
    let events: TurnEvent[];
    beforeAll(async () => {
      h = await makeHarness();
    });
    afterAll(async () => {
      if (h) await h.close();
    });
    beforeEach(async () => {
      await h.reset();
      clock = new Clock();
      events = [];
    });

    function services(model: AgentModel, store: WalkerStore = h.store()) {
      return {
        walkers: new WalkerService(store, { now: clock.now, assistant: createWalkerAssistant({ model }), onTurn: (e) => void events.push(e), onHelp: () => {} }),
        circle: new CircleService(store, { now: clock.now, onHelp: () => {} }),
      };
    }

    /** A walker with her phone, and approved caretakers in joining order (a waiting one too, when asked). */
    async function walkerWith(s: ReturnType<typeof services>, caretakers: string[], waiting = false) {
      const { secret, response } = await s.walkers.createPairingCode({ kind: "owner", secret: undefined });
      const paired = await s.walkers.pair({ code: response.code, service_version: "pi-0.1.0", name: "Rose's walker" }, "203.0.113.5");
      await s.walkers.heartbeat(device(paired.credential), paired.device_id, { sent_at: clock.iso(), service_version: "pi-0.1.0", manifest: manifest(clock), snapshot: snapshot(clock), events: [] });
      const join = async (name: string, role: "walker_user" | "caregiver") => {
        clock.advance(1_000);
        const { invite } = await s.circle.addPhone(owner(secret), paired.device_id, { name, role });
        return (await s.circle.join(phone(uuid()), { code: invite.code, consent: { circle_data_notice: true } }, "198.51.100.7")).secret;
      };
      const rose = await join("Rose", "walker_user");
      const phones: Record<string, string> = {};
      for (const name of caretakers) {
        phones[name] = await join(name, "caregiver");
        const j = (await s.circle.ownerCircle(owner(secret), paired.device_id)).joins.find((x) => x.name === name)!;
        await s.circle.approveJoin(owner(secret), paired.device_id, j.member_id, { consent: { walker_user_agreed: true } });
      }
      if (waiting) await join("Ben", "caregiver");
      return { secret, id: paired.device_id, credential: paired.credential, rose, phones };
    }

    const talk = (text: string, can = true): DeviceTurnRequest => ({ client_turn_id: uuid(), input: { type: "text", text }, snapshot: snapshot(clock), ...(can ? { can_ask_for_help: true as const } : {}) });
    const parses = (r: WalkerTurnResponse) => expect(WalkerTurnResponseSchema.safeParse(r).success).toBe(true);
    const context = (r: AgentRequest) => JSON.parse(r.context) as Record<string, unknown>;

    it("V1, V2, V7: offers the tool, answers with the fixed countdown line and ask_for_help, creates nothing, and says it again on a replay", async () => {
      const stub = stubModel(HELP_CALL);
      const s = services(stub.model);
      const w = await walkerWith(s, ["Maya", "Ana"], true);
      const request = talk("I've fallen. Please get Maya.");
      const r = await s.walkers.turn(device(w.credential), w.id, request);
      parses(r);
      expect(r.turn.reply).toBe(COUNTDOWN);
      expect(r.turn.answered_by).toBe("fixed");
      expect(r.ask_for_help).toBe(true);
      expect(r.proposal).toBeNull();
      expect(r.message_offer).toBeUndefined();
      expect(r.tool_call).toBeUndefined();
      expect(events.at(-1)?.reason).toBe("ask_for_help");
      expect((await s.walkers.help(device(w.credential), w.id)).help).toBeNull();
      // V2: what the model was offered.
      expect(stub.requests[0]!.schema).toBe(WALKER_REPLY_JSON_SCHEMA_WITH_HELP);
      expect(JSON.stringify(stub.requests[0]!.schema)).toContain("ask_for_help");
      expect(context(stub.requests[0]!).ask_for_help).toEqual(expect.any(String));
      expect(stub.requests[0]!.system).toBe(WALKER_SYSTEM_PROMPT);
      expect(WALKER_SYSTEM_PROMPT).toContain("Never claim to have called, told or reached anyone, or closed a request.");
      // V7: the Pi lost the answer and sends the turn again.
      const replay = await s.walkers.turn(device(w.credential), w.id, request);
      parses(replay);
      expect(replay.turn.reply).toBe(COUNTDOWN);
      expect(replay.ask_for_help).toBe(true);
      expect(stub.requests).toHaveLength(1);
      expect((await h.store().recentTurns(w.id, 10)).filter((t) => t.client_turn_id === request.client_turn_id)).toHaveLength(1);
    });

    it("V9: an empty reply beside ask_for_help is accepted at once (one model call) and gets the countdown line", async () => {
      const stub = stubModel({ transcript: "I've fallen. Please get Maya.", reply: "", tool_call: { name: "ask_for_help" } });
      const s = services(stub.model);
      const w = await walkerWith(s, ["Maya", "Ana"], true);
      const r = await s.walkers.turn(device(w.credential), w.id, talk("I've fallen. Please get Maya."));
      parses(r);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]!.retry).toBeNull();
      expect(r.turn.reply).toBe(COUNTDOWN);
      expect(r.ask_for_help).toBe(true);
    });

    it("V10: an empty reply without ask_for_help is sent back once with a note; never spoken empty", async () => {
      const stub = stubModel({ reply: "" });
      const s = services(stub.model);
      const w = await walkerWith(s, ["Maya"], true);
      const r = await s.walkers.turn(device(w.credential), w.id, talk("Hello"));
      parses(r);
      expect(stub.requests.length).toBeGreaterThan(1);
      expect(stub.requests[1]!.retry).toMatch(/reply/);
      expect(r.turn.reply.length).toBeGreaterThan(0);
      expect(r.turn.answered_by).toBe("fixed");
      expect(r.ask_for_help).toBeUndefined();
    });

    it("V11: the prompt says to leave the reply empty for ask_for_help, and never to offer to call anyone", () => {
      expect(WALKER_SYSTEM_PROMPT).toContain("so leave reply empty");
      expect(WALKER_SYSTEM_PROMPT).toContain("never say you can call anyone");
    });

    it("V3: an older walker (no can_ask_for_help) isn't offered it, and a model that sets it anyway is ignored", async () => {
      const stub = stubModel(HELP_CALL);
      const s = services(stub.model);
      const w = await walkerWith(s, ["Maya"]);
      const r = await s.walkers.turn(device(w.credential), w.id, talk("I've fallen.", false));
      parses(r);
      expect(stub.requests[0]!.schema).toBe(WALKER_REPLY_JSON_SCHEMA);
      expect(JSON.stringify(stub.requests[0]!.schema)).not.toContain("ask_for_help");
      expect(context(stub.requests[0]!).ask_for_help).toBeUndefined();
      expect(r.ask_for_help).toBeUndefined();
      expect(r.turn.answered_by).toBe("fixed");
      expect(r.turn.reply).not.toContain("I've told");
      expect(events.at(-1)?.reason).toBe("help_not_offered");
      expect((await s.walkers.help(device(w.credential), w.id)).help).toBeNull();
    });

    it("V4: never offered on the owner's page; a model that sets it anyway gets the device-only line", async () => {
      const stub = stubModel(HELP_CALL);
      const s = services(stub.model);
      const w = await walkerWith(s, ["Maya"]);
      const r = await s.walkers.turn(owner(w.secret), w.id, { client_turn_id: uuid(), input: { type: "text", text: "Get Maya, I fell." } });
      parses(r);
      expect(stub.requests[0]!.schema).toBe(WALKER_REPLY_JSON_SCHEMA);
      expect(r.ask_for_help).toBeUndefined();
      expect(r.turn.reply).toBe("Please use Talk on the walker for that request.");
    });

    it("V5: with no approved caretaker (her phone and a waiting one), the fixed no-caretaker line", async () => {
      const stub = stubModel(HELP_CALL);
      const s = services(stub.model);
      const w = await walkerWith(s, [], true);
      const r = await s.walkers.turn(device(w.credential), w.id, talk("Help, I can't get up."));
      parses(r);
      expect(r.turn.reply).toBe(NO_CARETAKER);
      expect(r.ask_for_help).toBeUndefined();
      expect(events.at(-1)?.reason).toBe("no_caretaker");
    });

    it("V6: while one is open, her walker turns carry one line about it; page turns and closed ones don't", async () => {
      const stub = stubModel({ reply: "Maya is on the way." });
      const s = services(stub.model);
      const w = await walkerWith(s, ["Maya", "Ana"]);
      const { response } = await s.walkers.askForHelp(device(w.credential), w.id, { client_help_id: uuid(), source: "handles" });
      await s.circle.home(phone(w.phones.Maya!));
      await s.circle.helpComing(phone(w.phones.Maya!), response.help.help_id);
      await s.walkers.turn(device(w.credential), w.id, talk("Is Maya coming?"));
      const line = context(stub.requests.at(-1)!).help_request;
      expect(line).toBe("Open: you asked for help; sent to Maya and Ana's phones; showing on Maya's phone; Maya is on the way");
      expect(String(line)).not.toMatch(/[0-9a-f]{8}-|latitude|longitude/);
      await s.walkers.turn(owner(w.secret), w.id, { client_turn_id: uuid(), input: { type: "text", text: "Is Maya coming?" } });
      expect(context(stub.requests.at(-1)!).help_request).toBeUndefined();
      await s.circle.helpOkay(phone(w.rose), response.help.help_id);
      await s.walkers.turn(device(w.credential), w.id, talk("Is Maya coming?"));
      expect(context(stub.requests.at(-1)!).help_request).toBeUndefined();
    });

    it("V8: with the circle unreachable, the tool isn't offered and the turn still answers", async () => {
      const stub = stubModel({ reply: "I'm here." });
      const base = h.store();
      // The SpacetimeDB store, found by shape, with a circle that never answers.
      const stuck = new Proxy(base, {
        has: (target, key) => key === "pingCare" || Reflect.has(target, key),
        get: (target, key) => {
          if (key === "pingCare") return async () => {};
          if (key === "circleOf") return () => new Promise(() => {});
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as WalkerStore;
      const s = services(stub.model);
      const w = await walkerWith(s, ["Maya"]);
      const r = await services(stub.model, stuck).walkers.turn(device(w.credential), w.id, talk("I fell."));
      parses(r);
      expect(r.turn.reply).toBe("I'm here.");
      expect(stub.requests[0]!.schema).toBe(WALKER_REPLY_JSON_SCHEMA);
    });
  });
}

describeHelpTurns("memory", async () => memoryHarness());

if (walkerTestDatabaseUrl) {
  const url = walkerTestDatabaseUrl;
  describeHelpTurns("postgres", () => postgresHarness(url));
} else {
  describe.skip(SKIP_POSTGRES, () => {
    it("needs a local cluster", () => {});
  });
}
