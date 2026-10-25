import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import {
  AnswerProposalRequestSchema,
  AnswerProposalResponseSchema,
  ConfigurationResponseSchema,
  DeviceAskForHelpRequestSchema,
  DeviceHelpStatusResponseSchema,
  DeviceMessagesResponseSchema,
  HELP_CLOSED_SHOWN_MS,
  HELP_COUNTDOWN_MS,
  HELP_OPEN_MAX_MS,
  HelpResponseSchema,
  WALKER_MESSAGES_KEPT,
  DeviceTurnRequestSchema,
  HeartbeatRequestSchema,
  HeartbeatResponseSchema,
  PROPOSAL_TTL_MS,
  PairDeviceRequestSchema,
  PairDeviceResponseSchema,
  VOICE_CLIP_MAX_BYTES,
  VOICE_CLIP_MAX_MS,
  WALKER_ERROR_STATUS,
  WALKER_SETUP,
  WalkerTurnResponseSchema,
  checkCuesChange,
  helpNames,
  isOpenProposal,
  zoneViews,
  type AnswerProposalResponse,
  type DeviceAskForHelpRequest,
  type HelpClosedHow,
  type HelpPerson,
  type HelpView,
  type Cue,
  type DeviceTurnRequest,
  type DeviceSendMessageRequest,
  type DeviceMessagesResponse,
  type WalkerIncomingMessage,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type PairDeviceRequest,
  type PairDeviceResponse,
  type PartView,
  type ProposalView,
  type WalkerConfiguration,
  type WalkerErrorCode,
  type WalkerEventView,
  type WalkerStatusView,
  type WalkerTurnResponse,
  type WalkerTurnView,
} from "@walker/contracts";
import type { z } from "zod";
import { readWav } from "../audio/wav";
import type { Clock } from "../clock";
import { CloudError, DEVICE_ROUTES, errorFromResponse, toCloudError, type CloudClient } from "../cloud/client";
import type { Logger } from "../log";

/**
 * A FAKE cloud for tests and `walker simulate`. It is not Sophi's assistant: it understands no speech, its
 * replies are scripted lines that say they come from the fake cloud, and every answer is `answered_by: "fixed"`.
 * It speaks the walker contract (packages/contracts/src/walker.ts), validates what the Pi sends against it,
 * and exists to exercise the Pi's side of pairing, heartbeats, configuration, turns and proposals.
 */
export interface FakeTurnScript {
  reply: string;
  /** Makes the fake open a `cues_change` proposal with these cues. */
  proposeCues?: Cue[];
  /** Makes the turn end with a spoken message draft to this (made-up) caretaker (tests). */
  offerMessage?: { to_name: string; text: string };
  /**
   * Makes the turn answer as a voice help request would (the server's fixed line and `ask_for_help: true`), only
   * on a turn that carries `can_ask_for_help` and with a caretaker in; like the server, otherwise not.
   */
  askForHelp?: true;
}

export class FakeCloudError extends Error {
  constructor(
    readonly code: WalkerErrorCode,
    message: string,
    readonly proposal?: ProposalView,
    readonly help?: HelpView,
  ) {
    super(message);
  }

  get status(): number {
    return WALKER_ERROR_STATUS[this.code];
  }

  body() {
    return {
      error: { code: this.code, message: this.message, trace_id: "fake", ...(this.proposal ? { proposal: this.proposal } : {}), ...(this.help ? { help: this.help } : {}) },
    };
  }
}

/** One help request as the fake cloud keeps it (made-up people: no real phone is told). */
interface FakeHelp {
  help_id: string;
  source: HelpView["source"];
  askedAt: number;
  sent_to: HelpPerson[];
  shown_to: HelpPerson[];
  coming: HelpPerson[];
  closed: { how: HelpClosedHow; by: HelpPerson | null; at: number } | null;
  clientIds: Set<string>;
}

interface FakeDevice {
  deviceId: string;
  credentialHash: string;
  configurations: WalkerConfiguration[];
  proposals: ProposalView[];
  lastHeartbeat: HeartbeatRequest | null;
  lastHeartbeatAt: number;
  events: WalkerEventView[];
  clips: Array<{ bytes: number; durationMs: number }>;
  turns: Map<string, { turn: WalkerTurnView; proposal: ProposalView | null; speech: WalkerTurnResponse["speech"] }>;
  /** Messages a (fake) caretaker sent to her phone, oldest first. */
  messages: WalkerIncomingMessage[];
  /** Help requests, oldest first. */
  help: FakeHelp[];
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const CUE_WORDS: Record<Cue, string> = { vibration: "vibration", sound: "short sounds", spoken: "spoken alerts", screen: "the screen" };

export class FakeCloud {
  private readonly codes = new Map<string, number>();
  readonly devices = new Map<string, FakeDevice>();
  private turnCount = 0;
  script: FakeTurnScript[] = [];
  /** When set (tests), every walker turn comes back with this WAV as the server's voiced reply. */
  speech: Buffer | null = null;
  /**
   * The approved caretaker phones in her (made-up) circle, in joining order: "Maya" by default. Empty makes asking
   * for help answer `409 no_caretaker`.
   */
  caretakers: HelpPerson[] = [{ member_id: "00000000-0000-4000-8000-00000000ca01", name: "Maya" }];
  /** Her own phone, which closes `okay` (null: she has no phone in, so the walker's okay is by nobody named). */
  herPhone: HelpPerson | null = { member_id: "00000000-0000-4000-8000-00000000ca00", name: "Rose" };
  /** False makes the help routes answer 404, like an older server. */
  helpRoutes = true;

  constructor(
    private readonly clock: Clock,
    private readonly initialCues: Cue[] = [...WALKER_SETUP.cues],
  ) {}

  private iso(ms = this.clock.now()) {
    return new Date(ms).toISOString();
  }

  issueCode(): string {
    const code = String(100000 + Math.floor(Math.random() * 900000));
    this.codes.set(code, this.clock.now() + 10 * 60_000);
    return code;
  }

  pair(request: PairDeviceRequest): PairDeviceResponse {
    const expires = this.codes.get(request.code);
    if (expires === undefined || expires < this.clock.now()) throw new FakeCloudError("pairing_code_invalid", "Unknown or expired code.");
    this.codes.delete(request.code);
    const deviceId = randomUUID();
    const credential = randomBytes(32).toString("base64url");
    const configuration: WalkerConfiguration = {
      version: 1,
      catalog_version: WALKER_SETUP.catalog_version,
      selected_module_ids: [...WALKER_SETUP.selected_module_ids],
      cues: [...this.initialCues],
      created_at: this.iso(),
    };
    this.devices.set(deviceId, {
      deviceId,
      credentialHash: sha256(credential),
      configurations: [configuration],
      proposals: [],
      lastHeartbeat: null,
      lastHeartbeatAt: 0,
      events: [],
      clips: [],
      turns: new Map(),
      messages: [],
      help: [],
    });
    return { device_id: deviceId, credential, configuration };
  }

  /** Revokes the walker's credential, like Forget this walker on the page. */
  forget(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  /** The walker named in the route, if this credential is its own; anything else looks unauthenticated. */
  authenticate(deviceId: string, credential: string | null): FakeDevice {
    const device = this.devices.get(deviceId);
    if (!device || !credential || device.credentialHash !== sha256(credential)) {
      throw new FakeCloudError("unauthenticated", "Unknown credential.");
    }
    return device;
  }

  current(device: FakeDevice): WalkerConfiguration {
    return device.configurations.at(-1)!;
  }

  /** The open proposal, expiring it first if its time is up (by the server's clock, never the Pi's). */
  private open(device: FakeDevice): ProposalView | null {
    const latest = device.proposals.at(-1);
    if (!latest || latest.state !== "open") return null;
    if (!isOpenProposal(latest, new Date(this.clock.now()))) {
      this.replace(device, { ...latest, state: "expired" });
      return null;
    }
    return latest;
  }

  private replace(device: FakeDevice, proposal: ProposalView): ProposalView {
    device.proposals = device.proposals.map((p) => (p.proposal_id === proposal.proposal_id ? proposal : p));
    return proposal;
  }

  heartbeat(device: FakeDevice, body: HeartbeatRequest): HeartbeatResponse {
    const now = this.clock.now();
    device.lastHeartbeat = body;
    device.lastHeartbeatAt = now;
    for (const event of body.events) {
      if (device.events.some((seen) => seen.event_id === event.event_id)) continue;
      device.events.push({ event_id: event.event_id, kind: event.kind, text: event.text, at: this.iso(now - event.ago_ms) });
    }
    device.events.splice(0, Math.max(0, device.events.length - 100));
    return { configuration_version: this.current(device).version, open_proposal: this.open(device) };
  }

  /** A fake caretaker's message to her phone (the simulator's `m` key, tests). Made up: there are no real phones here. */
  sendFromCaretaker(deviceId: string, fromName: string, text: string): WalkerIncomingMessage {
    const device = this.devices.get(deviceId);
    if (!device) throw new FakeCloudError("not_found", "Unknown walker.");
    const message = { message_id: randomUUID(), from_name: fromName, text };
    device.messages.push(message);
    return message;
  }

  /** Deletes a message, as the server does after 24 hours or when a phone is removed. */
  deleteMessage(deviceId: string, messageId: string): void {
    const device = this.devices.get(deviceId);
    if (device) device.messages = device.messages.filter((m) => m.message_id !== messageId);
  }

  messages(device: FakeDevice): DeviceMessagesResponse {
    return { messages: device.messages.slice(-WALKER_MESSAGES_KEPT) };
  }

  // ---- Asking for help (the walker contract's device routes; the phones are made up) ----

  private helpView(help: FakeHelp): HelpView {
    return {
      help_id: help.help_id,
      source: help.source,
      age_seconds: Math.max(0, Math.floor((this.clock.now() - help.askedAt) / 1000)),
      sent_to: [...help.sent_to],
      shown_to: [...help.shown_to],
      coming: [...help.coming],
      closed: help.closed ? { how: help.closed.how, by: help.closed.by } : null,
    };
  }

  private checkHelpRoutes(): void {
    if (!this.helpRoutes) throw new FakeCloudError("not_found", "Not found.");
  }

  /** The open request (closing it `expired` first if HELP_OPEN_MAX_MS has passed), or null. */
  private openHelp(device: FakeDevice): FakeHelp | null {
    const latest = device.help.at(-1);
    if (!latest || latest.closed) return null;
    if (this.clock.now() - latest.askedAt >= HELP_OPEN_MAX_MS) {
      latest.closed = { how: "expired", by: null, at: latest.askedAt + HELP_OPEN_MAX_MS };
      return null;
    }
    return latest;
  }

  /** POST /devices/{id}/help: 201 new, 200 the one open or a repeated client id; 409 no_caretaker. */
  askForHelp(device: FakeDevice, body: DeviceAskForHelpRequest): { status: 200 | 201; help: HelpView } {
    this.checkHelpRoutes();
    const repeated = device.help.find((h) => h.clientIds.has(body.client_help_id));
    if (repeated) return { status: 200, help: this.helpView(repeated) };
    const open = this.openHelp(device);
    if (open) {
      open.clientIds.add(body.client_help_id);
      return { status: 200, help: this.helpView(open) };
    }
    if (this.caretakers.length === 0) throw new FakeCloudError("no_caretaker", "No caretaker phone is linked to this walker.");
    const help: FakeHelp = {
      help_id: randomUUID(),
      source: body.source,
      askedAt: this.clock.now(),
      sent_to: this.caretakers.map((p) => ({ ...p })),
      shown_to: [],
      coming: [],
      closed: null,
      clientIds: new Set([body.client_help_id]),
    };
    device.help.push(help);
    return { status: 201, help: this.helpView(help) };
  }

  /** GET /devices/{id}/help: the open one, or the newest closed within HELP_CLOSED_SHOWN_MS, or null. */
  helpStatus(device: FakeDevice): { help: HelpView | null } {
    this.checkHelpRoutes();
    const open = this.openHelp(device);
    if (open) return { help: this.helpView(open) };
    const latest = device.help.at(-1);
    if (latest?.closed && this.clock.now() - latest.closed.at < HELP_CLOSED_SHOWN_MS) return { help: this.helpView(latest) };
    return { help: null };
  }

  /** POST /devices/{id}/help/{help_id}/okay: closes it `okay` by her phone (null without one); 409 help_closed. */
  helpOkay(device: FakeDevice, helpId: string): { help: HelpView } {
    this.checkHelpRoutes();
    this.openHelp(device);
    const help = device.help.find((h) => h.help_id === helpId);
    if (!help) throw new FakeCloudError("not_found", "Unknown help request.");
    if (help.closed) throw new FakeCloudError("help_closed", "That help request is already closed.", undefined, this.helpView(help));
    help.closed = { how: "okay", by: this.herPhone ? { ...this.herPhone } : null, at: this.clock.now() };
    return { help: this.helpView(help) };
  }

  private fakeOpenHelp(deviceId: string): FakeHelp {
    const device = this.devices.get(deviceId);
    const open = device ? this.openHelp(device) : null;
    if (!open) throw new Error("No open help request on the fake cloud.");
    return open;
  }

  private caretaker(name: string): HelpPerson {
    return this.caretakers.find((p) => p.name === name) ?? this.caretakers[0] ?? { member_id: "00000000-0000-4000-8000-00000000ca01", name };
  }

  /** A fake caretaker's app received the open request (the simulator's key; made up, no real phone). */
  helpShownOn(deviceId: string, name = "Maya"): void {
    const open = this.fakeOpenHelp(deviceId);
    const person = this.caretaker(name);
    if (!open.shown_to.some((p) => p.member_id === person.member_id)) open.shown_to.push({ ...person });
  }

  /** A fake caretaker answered "I'm on my way" (it also shows on that phone). */
  helpComing(deviceId: string, name = "Maya"): void {
    this.helpShownOn(deviceId, name);
    const open = this.fakeOpenHelp(deviceId);
    const person = this.caretaker(name);
    if (!open.coming.some((p) => p.member_id === person.member_id)) open.coming.push({ ...person });
  }

  /** A fake caretaker answered "I'm with Rose": closes it `with_her`. */
  helpWithHer(deviceId: string, name = "Maya"): void {
    const open = this.fakeOpenHelp(deviceId);
    open.closed = { how: "with_her", by: { ...this.caretaker(name) }, at: this.clock.now() };
  }

  /** Her own (fake) phone asked for help (`source: phone`). */
  helpFromPhone(deviceId: string): HelpView {
    const device = this.devices.get(deviceId);
    if (!device) throw new FakeCloudError("not_found", "Unknown walker.");
    const { help } = this.askForHelp(device, { client_help_id: randomUUID(), source: "handles" });
    const kept = device.help.find((h) => h.help_id === help.help_id)!;
    kept.source = "phone";
    return this.helpView(kept);
  }

  /** Her own (fake) phone said "I'm okay now", or the request expired. */
  closeHelp(deviceId: string, how: "okay" | "expired"): void {
    const open = this.fakeOpenHelp(deviceId);
    open.closed = { how, by: how === "okay" && this.herPhone ? { ...this.herPhone } : null, at: this.clock.now() };
  }

  configuration(device: FakeDevice): { configuration: WalkerConfiguration } {
    return { configuration: this.current(device) };
  }

  turn(device: FakeDevice, body: DeviceTurnRequest): WalkerTurnResponse {
    const seen = device.turns.get(body.client_turn_id);
    if (seen) return { ...seen, status: this.status(device) };
    let seconds = 0;
    if (body.input.type === "audio") {
      const wav = Buffer.from(body.input.data_base64, "base64");
      if (wav.length > VOICE_CLIP_MAX_BYTES) throw new FakeCloudError("invalid_request", "Clip too large.");
      const info = readWav(wav);
      if (info.sampleRate !== 16000 || info.channels !== 1 || info.bitsPerSample !== 16) {
        throw new FakeCloudError("invalid_request", "Clip must be 16 kHz mono 16-bit.");
      }
      const durationMs = Math.floor(info.pcm.length / 32);
      if (durationMs > VOICE_CLIP_MAX_MS) throw new FakeCloudError("invalid_request", "Clip over 15 s.");
      device.clips.push({ bytes: wav.length, durationMs });
      seconds = Math.round(durationMs / 100) / 10;
      wav.fill(0);
    }
    this.turnCount += 1;
    const step = this.script.shift();
    const configuration = this.current(device);
    let proposal: ProposalView | null = null;
    if (step?.proposeCues && checkCuesChange(configuration.cues, step.proposeCues, configuration.selected_module_ids) === null) {
      const previous = this.open(device);
      if (previous) this.replace(device, { ...previous, state: "superseded" });
      const now = this.clock.now();
      proposal = {
        proposal_id: randomUUID(),
        client_turn_id: body.client_turn_id,
        kind: "cues_change",
        from_cues: [...configuration.cues],
        cues: [...step.proposeCues],
        base_configuration_version: configuration.version,
        summary: `Switch obstacle alerts to ${step.proposeCues.map((cue) => CUE_WORDS[cue]).join(" and ")}.`,
        state: "open",
        created_at: this.iso(now),
        expires_at: this.iso(now + PROPOSAL_TTL_MS),
        configuration_version: null,
      };
      device.proposals.push(proposal);
    }
    const speech = this.speech ? { mime: "audio/wav" as const, data_base64: this.speech.toString("base64") } : null;
    // Asking for help by voice, as the server words it (help.md, "The server's voice path"): offered only on a turn
    // that carries can_ask_for_help, and only with a caretaker in.
    const asks = step?.askForHelp === true && body.can_ask_for_help === true && this.caretakers.length > 0;
    const helpReply = step?.askForHelp
      ? this.caretakers.length === 0
        ? "No caretaker's phone is linked to this walker, so I can't ask anyone. If you need help now, call 911 from your phone."
        : asks
          ? `I'll ask ${helpNames(this.caretakers.map((p) => p.name))} for help in ${HELP_COUNTDOWN_MS / 1000} seconds. Press any button to stop.`
          : null
      : null;
    const turn: WalkerTurnView = {
      turn_id: randomUUID(),
      client_turn_id: body.client_turn_id,
      source: "walker",
      heard: null,
      heard_by: null,
      reply:
        helpReply ??
        step?.reply ??
        `Fake cloud reply ${this.turnCount}: I received a ${seconds} second clip. The real assistant isn't connected in this run.`,
      answered_by: "fixed",
      voiced_by: speech ? "cartesia" : "walker",
      created_at: this.iso(),
    };
    device.turns.set(body.client_turn_id, { turn, proposal, speech });
    const offer = step?.offerMessage
      ? { message_offer: { client_message_id: randomUUID(), to_member_id: randomUUID(), to_name: step.offerMessage.to_name, text: step.offerMessage.text } }
      : {};
    return { turn, proposal, speech, status: this.status(device), ...offer, ...(asks ? { ask_for_help: true as const } : {}) };
  }

  answer(device: FakeDevice, proposalId: string, answer: "confirm" | "decline"): AnswerProposalResponse {
    const known = device.proposals.find((p) => p.proposal_id === proposalId);
    if (!known) throw new FakeCloudError("not_found", "Unknown proposal.");
    const open = this.open(device);
    if (!open || open.proposal_id !== proposalId) {
      const now = device.proposals.find((p) => p.proposal_id === proposalId)!;
      throw new FakeCloudError("proposal_closed", "That proposal is no longer open.", now);
    }
    const configuration = this.current(device);
    let next: ProposalView;
    if (answer === "decline") next = { ...open, state: "declined" };
    else if (open.base_configuration_version !== configuration.version) next = { ...open, state: "superseded" };
    else {
      const version = configuration.version + 1;
      device.configurations.push({ ...configuration, version, cues: [...open.cues], created_at: this.iso() });
      next = { ...open, state: "confirmed", configuration_version: version };
    }
    this.replace(device, next);
    if (next.state === "superseded") throw new FakeCloudError("proposal_closed", "That proposal is no longer open.", next);
    return { proposal: next, status: this.status(device) };
  }

  /** The status view, built the way the contract describes (a fake builds it from its own records). */
  status(device: FakeDevice): WalkerStatusView {
    const now = this.clock.now();
    const manifest = device.lastHeartbeat?.manifest ?? null;
    const configuration = this.current(device);
    const parts: PartView[] = (manifest?.modules ?? []).map((m) => ({
      module_id: m.module_id,
      instance_id: m.instance_id,
      health: m.health,
      simulated: m.simulated || manifest!.simulator,
      in_configuration: configuration.selected_module_ids.includes(m.module_id),
    }));
    for (const id of configuration.selected_module_ids) {
      if (!parts.some((p) => p.module_id === id)) {
        parts.push({ module_id: id, instance_id: null, health: "unavailable", simulated: false, in_configuration: true });
      }
    }
    return {
      device_id: device.deviceId,
      name: "Fake-cloud walker",
      online: true,
      last_seen_at: device.lastHeartbeatAt ? this.iso(device.lastHeartbeatAt) : null,
      simulator: manifest?.simulator ?? false,
      configuration,
      applied_configuration_version: manifest?.device_configuration_version ?? null,
      parts: parts.slice(0, 32),
      zones: zoneViews(device.lastHeartbeat?.snapshot ?? null, manifest, device.lastHeartbeatAt, now, true),
      open_proposal: this.open(device),
      turns: [...device.turns.values()].map((t) => t.turn).slice(-10),
      walker_said: device.events.slice(-10),
    };
  }
}

/** A switch for the fake network: `down` refuses at once, `hang` never answers. */
export type FakeNetwork = "up" | "down" | "hang";

/**
 * In-process client for unit tests: the fake cloud behind the CloudClient interface, with a network switch.
 * It checks every request and response against the contract, and turns fake errors into CloudErrors the
 * same way the HTTP client does.
 */
export class FakeCloudClient implements CloudClient {
  network: FakeNetwork = "up";
  calls: string[] = [];
  /** Calls named here wait for `releaseHeld()` and ignore their abort signal, like a server that answers late. */
  hold = new Set<string>();
  /** Calls named here are answered by the server at once, but the answer arrives only at `releaseHeld()`. */
  late = new Set<string>();
  private held: Array<() => void> = [];

  constructor(
    readonly cloud: FakeCloud,
    private readonly deviceId: string,
    private readonly credential: string,
  ) {}

  releaseHeld(): void {
    for (const release of this.held.splice(0)) release();
  }

  private call<S extends z.ZodType>(name: string, signal: AbortSignal, schema: S, work: () => unknown): Promise<z.infer<S>> {
    this.calls.push(name);
    const run = (): z.infer<S> => {
      try {
        return schema.parse(work());
      } catch (error) {
        if (error instanceof FakeCloudError) throw errorFromResponse(error.status, error.body());
        throw error;
      }
    };
    if (this.late.has(name)) {
      let outcome: { value: z.infer<S> } | { error: unknown };
      try {
        outcome = { value: run() };
      } catch (error) {
        outcome = { error };
      }
      return new Promise((resolve, reject) =>
        this.held.push(() => ("value" in outcome ? resolve(outcome.value) : reject(outcome.error))),
      );
    }
    if (this.hold.has(name)) {
      return new Promise((resolve, reject) =>
        this.held.push(() => {
          try {
            resolve(run());
          } catch (error) {
            reject(error);
          }
        }),
      );
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(toCloudError(signal.reason, signal));
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      if (this.network === "hang") return;
      queueMicrotask(() => {
        signal.removeEventListener("abort", onAbort);
        if (this.network === "down") return reject(toCloudError(new TypeError("fetch failed"), signal));
        try {
          resolve(run());
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  private device() {
    return this.cloud.authenticate(this.deviceId, this.credential);
  }

  heartbeat(body: HeartbeatRequest, signal: AbortSignal) {
    return this.call("heartbeat", signal, HeartbeatResponseSchema, () =>
      this.cloud.heartbeat(this.device(), HeartbeatRequestSchema.parse(body)),
    );
  }

  async configuration(signal: AbortSignal) {
    const response = await this.call("configuration", signal, ConfigurationResponseSchema, () => this.cloud.configuration(this.device()));
    return response.configuration;
  }

  turn(body: DeviceTurnRequest, signal: AbortSignal) {
    return this.call("turn", signal, WalkerTurnResponseSchema, () => this.cloud.turn(this.device(), DeviceTurnRequestSchema.parse(body)));
  }

  sendMessage(_body: DeviceSendMessageRequest, _signal: AbortSignal): Promise<{ sent: true }> {
    return Promise.reject(new CloudError("rejected", "The fake cloud has no approved phones."));
  }

  incomingMessages(signal: AbortSignal) {
    return this.call("messages", signal, DeviceMessagesResponseSchema, () => this.cloud.messages(this.device()));
  }

  async askForHelp(body: DeviceAskForHelpRequest, signal: AbortSignal) {
    const response = await this.call("help:ask", signal, HelpResponseSchema, () => ({ help: this.cloud.askForHelp(this.device(), DeviceAskForHelpRequestSchema.parse(body)).help }));
    return response.help;
  }

  async helpStatus(signal: AbortSignal) {
    const response = await this.call("help:status", signal, DeviceHelpStatusResponseSchema, () => this.cloud.helpStatus(this.device()));
    return response.help;
  }

  async helpOkay(helpId: string, signal: AbortSignal) {
    const response = await this.call("help:okay", signal, HelpResponseSchema, () => this.cloud.helpOkay(this.device(), helpId));
    return response.help;
  }

  answerProposal(proposalId: string, answer: "confirm" | "decline", signal: AbortSignal) {
    return this.call(`answer:${answer}`, signal, AnswerProposalResponseSchema, () => this.cloud.answer(this.device(), proposalId, answer));
  }
}

async function readBody(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new FakeCloudError("invalid_request", "Body too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new FakeCloudError("invalid_request", "Body is not JSON.");
  }
}

export interface FakeCloudServer {
  url: string;
  setNetwork(mode: FakeNetwork): void;
  close(): Promise<void>;
}

const DEVICE_PATH = /^\/api\/v1\/devices\/([^/]+)\/(heartbeat|configuration|turns|messages|help|proposals\/([^/]+)|help\/([^/]+)\/okay)$/;

/** Serves the fake cloud on 127.0.0.1 over plain HTTP (allowed only to this machine), on the contract's device routes. */
/**
 * `turnDelayMs` holds each turn's answer that long (the simulator's WALKER_FAKE_TURN_MS), so the screen's "One moment"
 * shows as it would while a real model answers. 0 by default: nothing else waits.
 */
export async function startFakeCloudServer(cloud: FakeCloud, log: Logger, turnDelayMs = 0): Promise<FakeCloudServer> {
  let network: FakeNetwork = "up";
  const sockets = new Set<Socket>();

  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const parse = <S extends z.ZodType>(schema: S, body: unknown, what: string): z.infer<S> => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      log.error(`fake cloud: ${what} failed the walker contract`, { issue: parsed.error.issues[0]?.message ?? "" });
      throw new FakeCloudError("invalid_request", `Invalid ${what}.`);
    }
    return parsed.data;
  };

  const server = createServer((request, response) => {
    if (network === "hang") return;
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const auth = request.headers.authorization;
        const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
        const body = await readBody(request, 3_000_000);
        if (request.method === "POST" && url.pathname === DEVICE_ROUTES.pair) {
          return send(response, 200, PairDeviceResponseSchema.parse(cloud.pair(parse(PairDeviceRequestSchema, body, "pairing"))));
        }
        const match = DEVICE_PATH.exec(url.pathname);
        if (!match?.[1]) throw new FakeCloudError("not_found", "Not found.");
        const device = cloud.authenticate(decodeURIComponent(match[1]), bearer);
        const route = match[2];
        if (request.method === "POST" && route === "heartbeat") {
          return send(response, 200, cloud.heartbeat(device, parse(HeartbeatRequestSchema, body, "heartbeat")));
        }
        if (request.method === "GET" && route === "configuration") return send(response, 200, cloud.configuration(device));
        if (request.method === "GET" && route === "messages") return send(response, 200, DeviceMessagesResponseSchema.parse(cloud.messages(device)));
        if (request.method === "POST" && route === "turns") {
          const answer = cloud.turn(device, parse(DeviceTurnRequestSchema, body, "turn"));
          if (turnDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, turnDelayMs));
          return send(response, 200, answer);
        }
        if (route === "help" && request.method === "GET") return send(response, 200, DeviceHelpStatusResponseSchema.parse(cloud.helpStatus(device)));
        if (route === "help" && request.method === "POST") {
          const asked = cloud.askForHelp(device, parse(DeviceAskForHelpRequestSchema, body, "help request"));
          return send(response, asked.status, HelpResponseSchema.parse({ help: asked.help }));
        }
        if (request.method === "POST" && match[4]) return send(response, 200, HelpResponseSchema.parse(cloud.helpOkay(device, decodeURIComponent(match[4]))));
        if (request.method === "POST" && match[3]) {
          const { answer } = parse(AnswerProposalRequestSchema, body, "answer");
          return send(response, 200, cloud.answer(device, decodeURIComponent(match[3]), answer));
        }
        throw new FakeCloudError("not_found", "Not found.");
      } catch (error) {
        if (error instanceof FakeCloudError) return send(response, error.status, error.body());
        log.error("fake cloud error", { error: error instanceof Error ? error.message : "error" });
        return send(response, 500, { error: { code: "unavailable", message: "Fake cloud error.", trace_id: "fake" } });
      }
    })();
  });
  server.on("connection", (socket) => {
    if (network === "down") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    setNetwork(mode) {
      network = mode;
      // Kept-alive connections would otherwise carry on past a "down" switch.
      if (mode !== "up") for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

