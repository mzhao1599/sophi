import { createHmac, randomBytes, randomInt } from "node:crypto";
import {
  AnswerProposalResponseSchema,
  HeartbeatResponseSchema,
  MAX_WALKERS_PER_OWNER,
  PAIRING_CODE_TTL_MS,
  PAIRING_LOCK_WINDOW_MS,
  PAIRING_MAX_WRONG,
  PROPOSAL_TTL_MS,
  RECENT_TURNS,
  WALKER_ERROR_STATUS,
  WALKER_HISTORY_RETENTION_MS,
  WALKER_SETUP,
  WalkerTurnResponseSchema,
  checkCuesChange,
  type AnswerProposalRequest,
  type AnswerProposalResponse,
  type DeviceTurnRequest,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type PageTurnRequest,
  type PairDeviceRequest,
  type PairDeviceResponse,
  type PairingCodeResponse,
  type ProposalView,
  type WalkerConfiguration,
  type WalkerErrorCode,
  type WalkerActivityView,
  type WalkerStatusView,
  type WalkerTurnResponse,
  type WalkerTurnView,
} from "@walker/contracts";
import type { ActivityLog, FlightHandle } from "./activity";
import { WALKER_TIMEOUT_MS, type AssistantResult, type WalkerAssistant, type Words } from "./assistant";
import {
  OFFLINE_NO_CHANGE,
  PRESS_CONFIRM,
  SIMULATED_ALL_PARTS,
  SIMULATED_PARTS,
  SIMULATED_READINGS,
  armsLine,
  cuesRefused,
  cuesSummary,
  fallbackLine,
  offerLine,
  stillWaiting,
} from "./lines";
import { isWav16kMono, wav16kMonoMs, type WalkerVoice } from "./speech";
import { buildStatusView } from "./status";
import { SECRET_PATTERN, newSecret, sha256, type DeviceRecord, type WalkerStore } from "./store";

export class WalkerError extends Error {
  override readonly name = "WalkerError";
  constructor(
    readonly code: WalkerErrorCode,
    message: string,
    /** For `proposal_closed`: the proposal as it stands. */
    readonly proposal?: ProposalView,
  ) {
    super(message);
  }

  get status(): number {
    return WALKER_ERROR_STATUS[this.code];
  }
}

/** By shape as well as class: a dev server's hot reload can leave instances from an older copy of this module. */
export function isWalkerError(error: unknown): error is WalkerError {
  return error instanceof WalkerError || (error instanceof Error && error.name === "WalkerError" && "code" in error);
}

/**
 * Who is calling, as the web layer read it. The Pi proves itself with its credential (the
 * `Authorization: Bearer` header) and the page with its owner secret (the `walker_owner` cookie). Each
 * route reads only its own proof, so neither works on the other's routes.
 */
export type DeviceCaller = { kind: "device"; credential: string | undefined };
export type OwnerCaller = { kind: "owner"; secret: string | undefined };
export type WalkerCaller = DeviceCaller | OwnerCaller;

export interface WalkerServiceOptions {
  now?: () => Date;
  randomId?: () => string;
  /** Six digits. */
  randomCode?: () => string;
  /** Set when this server must not serve walkers (production without a database): every call answers 503 with it. */
  blocked?: string;
  /** The model step for turns; without one, every turn gets a fixed line. */
  assistant?: WalkerAssistant | null;
  /** Sophi's spoken voice for walker turns; without one, the walker speaks replies itself. */
  voice?: WalkerVoice | null;
  /** One event per turn, for the log: ids, outcomes and timings, never words. */
  onTurn?: (event: TurnEvent) => void;
  /** The whole turn's time limit, voice included (default TURN_BUDGET_MS). */
  turnBudgetMs?: number;
  /** The voice's own limit (default VOICE_TIMEOUT_MS). */
  voiceTimeoutMs?: number;
  /**
   * The page's live companion: turns in flight and recent turn traces, in memory. One per server
   * process (sharedWalkerActivity), since a service is built per request. Without one, nothing is tracked.
   */
  activity?: ActivityLog | null;
}

export interface TurnEvent {
  device_id: string;
  source: "walker" | "page";
  input: "audio" | "text";
  replayed: boolean;
  answered_by: "model" | "fixed";
  /** Why the model's reply wasn't used as is, or null. */
  reason: string | null;
  attempts: number;
  /** The model whose answer (or failure) the turn used; null when no model ran. */
  model: string | null;
  model_ms: number;
  voiced_by: "cartesia" | "walker" | null;
  voice_ms: number;
  proposal_opened: boolean;
  ms: number;
}

/**
 * The Pi gives up on a turn after 10 s. The server's part (from reading the upload to having the reply
 * and its audio) stays within this, which leaves time for the audio's download over a phone hotspot.
 */
const TURN_BUDGET_MS = 8_000;
const VOICE_TIMEOUT_MS = 3_000;
/** Less time than this left for the voice isn't worth a call. */
const VOICE_MIN_MS = 500;

const DEFAULT_NAME = "My walker";
/**
 * Keys the hash of a client address for the lockout. It lives only in this process's memory, so a stored
 * hash can't be reversed by trying every IPv4 address; a restart forgets the tries, which only matter
 * for 10 minutes anyway.
 */
const ADDRESS_KEY = randomBytes(32);
const CLOSED: Record<Exclude<ProposalView["state"], "open">, string> = {
  confirmed: "That change was already confirmed.",
  declined: "That change was already declined.",
  expired: "That suggestion has expired. Ask again if you still want it.",
  superseded: "A newer suggestion replaced that one.",
};

/**
 * The walker API's behaviour, independent of HTTP: pairing, the two proofs, heartbeats, the status
 * view and answering proposals. Route handlers parse requests with the contract schemas, call this,
 * and map WalkerError to the error envelope. Nothing here moves hardware; the only change it makes to
 * a walker is a new configuration version, and only when a person confirms a proposal.
 */
export class WalkerService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomCode: () => string;
  private readonly blocked: string | undefined;
  private readonly assistant: WalkerAssistant | null;
  private readonly voice: WalkerVoice | null;
  private readonly onTurn: (event: TurnEvent) => void;
  private readonly turnBudgetMs: number;
  private readonly voiceTimeoutMs: number;
  private readonly activity: ActivityLog | null;

  constructor(
    private readonly store: WalkerStore,
    options: WalkerServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.randomCode = options.randomCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
    this.blocked = options.blocked;
    this.assistant = options.assistant ?? null;
    this.voice = options.voice ?? null;
    this.onTurn = options.onTurn ?? logTurn;
    this.turnBudgetMs = options.turnBudgetMs ?? TURN_BUDGET_MS;
    this.voiceTimeoutMs = options.voiceTimeoutMs ?? VOICE_TIMEOUT_MS;
    this.activity = options.activity ?? null;
  }

  /** At server start: the store's migrations, then the history sweep. */
  async prepare(): Promise<void> {
    await this.begin();
    await this.sweep(this.now());
  }

  // ---- Pairing ----

  /**
   * A one-time code for the owner's page. A browser without a valid owner secret gets a new one, which
   * the web layer puts in the `walker_owner` cookie. A newer code replaces the owner's earlier one.
   */
  async createPairingCode(caller: OwnerCaller): Promise<{ secret: string; response: PairingCodeResponse }> {
    await this.begin();
    const secret = caller.secret && SECRET_PATTERN.test(caller.secret) ? caller.secret : newSecret();
    const owner = sha256(secret);
    if ((await this.store.countDevices(owner)) >= MAX_WALKERS_PER_OWNER) throw limitError();
    const now = this.now();
    const expires_at = new Date(now.getTime() + PAIRING_CODE_TTL_MS).toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = this.randomCode();
      if (await this.store.putPairingCode({ code, owner_hash: owner, created_at: now.toISOString(), expires_at }, now)) {
        return { secret, response: { code, expires_at } };
      }
    }
    throw new WalkerError("unavailable", "Couldn't make a pairing code just now. Please try again.");
  }

  /**
   * The Pi claims a code. `clientAddress` keys the wrong-code lockout: PAIRING_MAX_WRONG wrong codes
   * within PAIRING_LOCK_WINDOW_MS lock it out until the oldest of them is that old (a sliding window).
   * Only a keyed hash of the address is stored.
   */
  async pair(request: PairDeviceRequest, clientAddress: string): Promise<PairDeviceResponse> {
    await this.begin();
    const now = this.now();
    const credential = newSecret();
    const configuration: WalkerConfiguration = { version: 1, ...WALKER_SETUP, cues: [...WALKER_SETUP.cues], created_at: now.toISOString() };
    const device = {
      device_id: this.randomId(),
      credential_hash: sha256(credential),
      name: storable(request.name ?? DEFAULT_NAME),
      service_version: storable(request.service_version),
      created_at: now.toISOString(),
    };
    const claim = await this.store.claimPairingCode({
      code: request.code,
      now,
      device,
      configuration,
      maxDevices: MAX_WALKERS_PER_OWNER,
      address_key: createHmac("sha256", ADDRESS_KEY).update(clientAddress).digest("hex"),
      triesSince: new Date(now.getTime() - PAIRING_LOCK_WINDOW_MS),
      maxWrong: PAIRING_MAX_WRONG,
    });
    if (!claim.ok && claim.reason === "locked") throw new WalkerError("pairing_locked", "Too many wrong codes from this network. Try again in 10 minutes.");
    if (!claim.ok && claim.reason === "busy") throw new WalkerError("rate_limited", "Another pairing try from this network is still running. Try again in a moment.");
    if (!claim.ok && claim.reason === "walker_limit") throw limitError();
    if (!claim.ok) throw new WalkerError("pairing_code_invalid", "That pairing code isn't right, or it has expired. Get a new one on the Your walker page.");
    return { device_id: claim.device.device_id, credential, configuration: claim.configuration };
  }

  // ---- The walker (device routes) ----

  async heartbeat(caller: DeviceCaller, deviceId: string, request: HeartbeatRequest): Promise<HeartbeatResponse> {
    const device = await this.resolve(caller, deviceId);
    const now = this.now();
    // Before this heartbeat counts: a gap longer than OFFLINE_AFTER_MS expires the open proposal for good.
    await this.store.expireProposals(device.device_id, now);
    const historySince = now.getTime() - WALKER_HISTORY_RETENTION_MS;
    const events = request.events
      .map((e) => ({ event_id: e.event_id, kind: e.kind, text: e.text, at: new Date(now.getTime() - e.ago_ms).toISOString() }))
      .filter((e) => Date.parse(e.at) >= historySince);
    await this.store.recordHeartbeat(
      device.device_id,
      storable({ at: now.toISOString(), service_version: request.service_version, manifest: request.manifest, snapshot: request.snapshot, events }),
    );
    await this.sweep(now);
    const [configuration, proposal] = await Promise.all([this.store.currentConfiguration(device.device_id), this.store.openProposal(device.device_id)]);
    return HeartbeatResponseSchema.parse({ configuration_version: configuration.version, open_proposal: proposal ?? null });
  }

  async configuration(caller: DeviceCaller, deviceId: string): Promise<{ configuration: WalkerConfiguration }> {
    const device = await this.resolve(caller, deviceId);
    return { configuration: await this.store.currentConfiguration(device.device_id) };
  }

  // ---- The owner's page ----

  // A page can keep reading a walker that has stopped sending heartbeats, so page reads sweep old
  // history too, once per request, before building any view.

  async list(caller: OwnerCaller): Promise<{ walkers: WalkerStatusView[]; activity?: WalkerActivityView[] }> {
    const owner = await this.owner(caller);
    const devices = await this.store.devicesForOwner(owner);
    await this.sweep(this.now());
    const walkers = await Promise.all(devices.map((d) => this.status(d)));
    // Page only, and only this owner's own walkers: the ids come from devicesForOwner, never the log.
    const activity = this.activity?.view(devices.map((d) => d.device_id)) ?? [];
    return activity.length > 0 ? { walkers, activity } : { walkers };
  }

  async get(caller: OwnerCaller, deviceId: string): Promise<{ walker: WalkerStatusView }> {
    const device = await this.resolve(caller, deviceId);
    await this.sweep(this.now());
    return { walker: await this.status(device) };
  }

  /** Forget this walker: deletes it and everything about it at once, which also revokes its credential. */
  async forget(caller: OwnerCaller, deviceId: string): Promise<void> {
    const device = await this.resolve(caller, deviceId);
    if (!(await this.store.forget(device.device_id, device.owner_hash))) throw notFound();
    this.activity?.forget(device.device_id);
  }

  // ---- Both ----

  /**
   * One question and its answer, from the walker (voice or text, with its snapshot) or the page (text).
   * A client_turn_id already stored gets that turn and its proposal back with a fresh status, and runs
   * nothing again. The model reads the walker's status; the server's rules decide the reply's fixed parts
   * and whether a proposal opens. Nothing here confirms anything.
   */
  async turn(caller: WalkerCaller, deviceId: string, request: DeviceTurnRequest | PageTurnRequest, receivedAt = Date.now()): Promise<WalkerTurnResponse> {
    // The budget counts from when the route started reading the request, so the upload is inside it.
    const started = receivedAt;
    const left = () => this.turnBudgetMs - (Date.now() - started);
    const device = await this.resolve(caller, deviceId);
    const source = caller.kind === "device" ? "walker" : "page";
    const input = request.input;
    await this.sweep(this.now());
    // Expire first, so a replay never hands back a proposal as open after it has expired.
    await this.store.expireProposals(device.device_id, this.now());
    const prior = await this.store.findTurn(device.device_id, request.client_turn_id);
    if (prior) {
      const response = WalkerTurnResponseSchema.parse({ ...prior, speech: null, status: await this.status(device) });
      this.onTurn({ ...turnEvent(device.device_id, source, input.type, prior.turn), replayed: true, ms: Date.now() - started });
      return response;
    }
    const clip = input.type === "audio" ? Buffer.from(input.data_base64, "base64") : null;
    if (clip && !isWav16kMono(clip)) {
      throw new WalkerError("invalid_request", "The voice clip must be a 16 kHz mono 16-bit WAV file.");
    }
    const clipMs = clip && wav16kMonoMs(clip);

    const now = this.now();
    // Accepted: the page's companion shows it until it ends, however it ends.
    const flight = this.activity?.begin(device.device_id, { client_turn_id: request.client_turn_id, input: input.type, since: now.toISOString(), clip_ms: clipMs });
    try {
      return await this.answerTurn(device, source, request, now, started, left, clipMs, flight);
    } finally {
      flight?.end();
    }
  }

  private async answerTurn(
    device: DeviceRecord,
    source: "walker" | "page",
    request: DeviceTurnRequest | PageTurnRequest,
    now: Date,
    started: number,
    left: () => number,
    clipMs: number | null,
    flight: FlightHandle | undefined,
  ): Promise<WalkerTurnResponse> {
    const input = request.input;
    // A walker's turn carries the snapshot it has at that moment, received now: it replaces the heartbeat's for this turn.
    const seen = "snapshot" in request ? { ...device, snapshot: request.snapshot, snapshot_received_at: request.snapshot ? now.toISOString() : null } : device;
    const status = await this.status(seen);
    const words: Words = input.type === "text" ? { type: "text", text: input.text } : { type: "audio", data_base64: input.data_base64 };
    const result = this.assistant ? await this.assistant.reply(status, source, words, now, Math.min(WALKER_TIMEOUT_MS, left())) : null;

    const decided = applyRules(status, device.manifest, result, () => this.randomId(), request.client_turn_id, now);
    const transcript = input.type === "audio" && result?.ok ? result.reply.transcript.trim() : "";
    const heard = input.type === "text" ? { heard: input.text, heard_by: "typed" as const } : transcript ? { heard: transcript, heard_by: "gemini" as const } : { heard: null, heard_by: null };

    const voiceStarted = Date.now();
    let voiceCalled = false;
    const speech =
      source === "walker"
        ? await this.speak(decided.reply, left(), () => {
            voiceCalled = true;
            flight?.stage("voicing");
          })
        : null;
    const voiceMs = Date.now() - voiceStarted;
    const turn: WalkerTurnView = storable({
      turn_id: this.randomId(),
      client_turn_id: request.client_turn_id,
      source,
      ...heard,
      reply: decided.reply,
      answered_by: decided.answered_by,
      voiced_by: source === "walker" ? (speech ? "cartesia" : "walker") : null,
      created_at: now.toISOString(),
    });
    const savedAt = this.now();
    const saved = await this.store.saveTurn(device.device_id, turn, decided.proposal, savedAt);
    // Forgotten while the model was answering.
    if (!saved) throw notFound();
    // The status read expires proposals (say the walker went offline during the turn), so read the
    // proposal after it: the response never calls a proposal open that isn't.
    const after = await this.status(device);
    const stored = await this.store.findTurn(device.device_id, request.client_turn_id);
    // Another upload of this turn saved first: its turn and proposal are the answer, without this one's audio.
    const response = WalkerTurnResponseSchema.parse({
      turn: saved.turn,
      proposal: stored?.proposal ?? saved.proposal,
      speech: saved.created && speech ? { mime: "audio/wav", data_base64: speech } : null,
      status: after,
    });
    const event: TurnEvent = {
      ...turnEvent(device.device_id, source, input.type, saved.turn),
      replayed: !saved.created,
      reason: decided.reason,
      attempts: result?.attempts ?? 0,
      model: result?.model ?? null,
      model_ms: result?.ms ?? 0,
      voice_ms: source === "walker" ? voiceMs : 0,
      proposal_opened: saved.created && decided.proposal !== null,
      ms: Date.now() - started,
    };
    this.onTurn(event);
    // Only a turn that saved a new row; another upload of it that saved first has its own trace.
    if (saved.created) {
      flight?.record({
        turn_id: saved.turn.turn_id,
        client_turn_id: saved.turn.client_turn_id,
        at: savedAt.toISOString(),
        input: input.type,
        clip_ms: clipMs,
        model_ran: event.attempts > 0,
        model_ms: event.attempts > 0 ? event.model_ms : null,
        rule: event.reason,
        answered_by: event.answered_by,
        proposal_opened: event.proposal_opened,
        voiced_by: event.voiced_by,
        voice_ms: voiceCalled ? event.voice_ms : null,
        total_ms: event.ms,
      });
    }
    return response;
  }

  /** `onCall` runs just before Cartesia is asked, so the page can show the voice step. */
  private async speak(text: string, leftMs: number, onCall: () => void): Promise<string | null> {
    const ms = Math.min(this.voiceTimeoutMs, leftMs);
    if (!this.voice || ms < VOICE_MIN_MS) return null;
    onCall();
    return this.voice.speak(text, AbortSignal.timeout(ms)).catch(() => null);
  }

  /** Confirm or decline by id, from the walker's Confirm button or the page. The first answer wins. */
  async answer(caller: WalkerCaller, deviceId: string, proposalId: string, request: AnswerProposalRequest): Promise<AnswerProposalResponse> {
    const device = await this.resolve(caller, deviceId);
    await this.sweep(this.now());
    const result = await this.store.answerProposal(device.device_id, proposalId, request.answer, this.now());
    if (result.outcome === "not_found") throw new WalkerError("not_found", "That suggestion wasn't found.");
    if (result.outcome === "closed") {
      throw new WalkerError("proposal_closed", CLOSED[result.proposal.state as keyof typeof CLOSED], result.proposal);
    }
    return AnswerProposalResponseSchema.parse({ proposal: result.proposal, status: await this.status(device) });
  }

  /** The status view, read after expiring proposals. Callers sweep old history first. */
  async status(device: DeviceRecord): Promise<WalkerStatusView> {
    const now = this.now();
    await this.store.expireProposals(device.device_id, now);
    const [configuration, proposal, turns, lines] = await Promise.all([
      this.store.currentConfiguration(device.device_id),
      this.store.openProposal(device.device_id),
      this.store.recentTurns(device.device_id, RECENT_TURNS),
      this.store.recentLines(device.device_id, RECENT_TURNS),
    ]);
    return buildStatusView({ device, configuration, proposal, turns, lines, now });
  }

  /**
   * The device a caller may act on. The Pi: its credential must be known (else 401, so it asks to be
   * paired again), and the id must be its own. The page: its owner secret must own the id. An unknown id
   * and someone else's both get 404, so ids can't be probed.
   */
  async resolve(caller: WalkerCaller, deviceId: string): Promise<DeviceRecord> {
    if (caller.kind === "owner") {
      const owner = await this.owner(caller);
      const device = await this.store.deviceForOwner(deviceId, owner);
      if (!device) throw notFound();
      return device;
    }
    await this.begin();
    if (!caller.credential || !SECRET_PATTERN.test(caller.credential)) throw unpaired();
    const device = await this.store.deviceByCredential(sha256(caller.credential));
    if (!device) throw unpaired();
    if (device.device_id !== deviceId) throw notFound();
    return device;
  }

  private async owner(caller: OwnerCaller): Promise<string> {
    await this.begin();
    if (!caller.secret || !SECRET_PATTERN.test(caller.secret)) {
      throw new WalkerError("unauthenticated", "This browser hasn't paired a walker yet.");
    }
    return sha256(caller.secret);
  }

  private async begin() {
    if (this.blocked) throw new WalkerError("unavailable", this.blocked);
    await this.store.ready();
  }

  private sweep(now: Date) {
    return this.store.sweep(now, new Date(now.getTime() - WALKER_HISTORY_RETENTION_MS), new Date(now.getTime() - PAIRING_LOCK_WINDOW_MS));
  }
}

/**
 * What Postgres can store: a NUL character or half of a UTF-16 surrogate pair in any string becomes
 * U+FFFD. Otherwise one such character in a queued line would fail every heartbeat until the walker
 * dropped the line a day later. Applied before either store, so both keep the same text.
 */
export function storable<T>(value: T): T {
  const clean = (text: string) => text.replace(/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === "string" ? clean(v) : v))) as T;
}

/**
 * The server's rules for a reply, all from structured fields (the model's topics and cues_change, the
 * status view, the manifest), never from words: what the person hears, who answered, and any proposal to open.
 */
export function applyRules(
  status: WalkerStatusView,
  manifest: DeviceRecord["manifest"],
  result: AssistantResult | null,
  newId: () => string,
  clientTurnId: string,
  now: Date,
): { reply: string; answered_by: "model" | "fixed"; reason: string | null; proposal: ProposalView | null } {
  if (!result?.ok) return { reply: withReminder(fallbackLine(status), status), answered_by: "fixed", reason: result?.reason ?? "no_model", proposal: null };
  const out = result.reply;
  if (out.topics.includes("arms")) return { reply: withReminder(armsLine(manifest), status), answered_by: "fixed", reason: "arms", proposal: null };
  if (out.cues_change) {
    const current = status.configuration;
    const problem = checkCuesChange(current.cues, out.cues_change.cues, current.selected_module_ids);
    if (problem) return { reply: withReminder(cuesRefused(problem, current.cues), status), answered_by: "fixed", reason: `cues_${problem}`, proposal: null };
    if (!status.online) return { reply: OFFLINE_NO_CHANGE, answered_by: "fixed", reason: "offline", proposal: null };
    const cues = out.cues_change.cues;
    const summary = cuesSummary(current.cues, cues);
    const proposal: ProposalView = {
      proposal_id: newId(),
      client_turn_id: clientTurnId,
      kind: "cues_change",
      from_cues: [...current.cues],
      cues: [...cues],
      base_configuration_version: current.version,
      summary,
      state: "open",
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString(),
      configuration_version: null,
    };
    // The person hears exactly what Confirm will do, from the payload, not the model's description of it.
    return { reply: `${offerLine(summary)} ${PRESS_CONFIRM}`, answered_by: "model", reason: null, proposal };
  }
  let reply = out.reply;
  const simulatedTof = status.parts.some((p) => p.module_id === "perception.tof" && p.instance_id !== null && p.simulated);
  // The parts the walker reports (a configured part it never reported has no instance and isn't counted).
  const reported = status.parts.filter((p) => p.instance_id !== null);
  const simulatedParts = reported.filter((p) => p.simulated).length;
  if (out.topics.includes("obstacles") && simulatedTof) reply = `${reply} ${SIMULATED_READINGS}`;
  else if (out.topics.includes("parts") && simulatedParts > 0) reply = `${reply} ${simulatedParts === reported.length ? SIMULATED_ALL_PARTS : SIMULATED_PARTS}`;
  return { reply: withReminder(reply, status), answered_by: "model", reason: null, proposal: null };
}

/** A turn that arrives while an earlier proposal is open says it's still waiting. */
function withReminder(reply: string, status: WalkerStatusView): string {
  return status.open_proposal ? `${reply} ${stillWaiting(status.open_proposal.summary)}` : reply;
}

function turnEvent(deviceId: string, source: "walker" | "page", input: "audio" | "text", turn: WalkerTurnView): TurnEvent {
  return {
    device_id: deviceId,
    source,
    input,
    replayed: false,
    answered_by: turn.answered_by,
    reason: null,
    attempts: 0,
    model: null,
    model_ms: 0,
    voiced_by: turn.voiced_by,
    voice_ms: 0,
    proposal_opened: false,
    ms: 0,
  };
}

function logTurn(e: TurnEvent) {
  console.info(
    `[walker] turn device=${e.device_id} source=${e.source} input=${e.input} replayed=${e.replayed} answered_by=${e.answered_by} reason=${e.reason ?? "none"} attempts=${e.attempts} model=${e.model ?? "none"} model_ms=${e.model_ms} voiced_by=${e.voiced_by ?? "none"} voice_ms=${e.voice_ms} proposal=${e.proposal_opened} ms=${e.ms}`,
  );
}

function notFound() {
  return new WalkerError("not_found", "This walker wasn't found. It may have been forgotten.");
}

function unpaired() {
  return new WalkerError("unauthenticated", "This walker isn't paired. Pair it again from the Your walker page.");
}

function limitError() {
  return new WalkerError("walker_limit", `This browser already has ${MAX_WALKERS_PER_OWNER} walkers. Forget one before pairing another.`);
}
