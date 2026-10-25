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
  type DeviceSpeechResponse,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type PageTurnRequest,
  type PairDeviceRequest,
  type PairDeviceResponse,
  type PairingCodeResponse,
  type ProposalView,
  type SpeechPace,
  type SpeechPaceResponse,
  type WalkerConfiguration,
  type WalkerErrorCode,
  type WalkerActivityView,
  type WalkerStatusView,
  type WalkerTurnResponse,
  type WalkerTurnView,
  type WalkerToolName,
  type WalkerToolResult,
  ROUTE_TOOLS,
  WALKER_MAX_TOOL_CALLS,
  CIRCLE_MESSAGE_RETENTION_MS,
  CIRCLE_INVITE_TTL_MS,
  MAX_CIRCLE_MEMBERS,
  MAX_OPEN_INVITES,
  MAX_LIVE_MESSAGES,
  DeviceSendMessageRequestSchema,
  type DeviceSendMessageRequest,
  DeviceMessagesResponseSchema,
  type DeviceMessagesResponse,
  WALKER_MESSAGES_KEPT,
  DeviceHelpStatusResponseSchema,
  HelpResponseSchema,
  type DeviceAskForHelpRequest,
  type DeviceHelpStatusResponse,
  type HelpResponse,
  type HelpView,
} from "@walker/contracts";
import type { ActivityLog, FlightHandle } from "./activity";
import { WALKER_TIMEOUT_MS, type AssistantResult, type WalkerAssistant, type Words } from "./assistant";
import {
  OFFLINE_NO_CHANGE,
  PACE_CHANGED,
  PACE_NO_VOICE,
  PACE_UNCHANGED,
  PRESS_CONFIRM,
  SIMULATED_ALL_PARTS,
  SIMULATED_PARTS,
  SIMULATED_READINGS,
  armsLine,
  cuesRefused,
  cuesSummary,
  fallbackLine,
  offerLine,
  distanceLine,
  stillWaiting,
} from "./lines";
import { isWav16kMono, wav16kMonoMs, type WalkerEars, type WalkerVoice } from "./speech";
import { buildStatusView } from "./status";
import {
  HELP_CLOSED_MESSAGE,
  HELP_NOT_FOUND_MESSAGE,
  NO_CARETAKER_MESSAGE,
  NO_CARETAKER_VOICE_LINE,
  answerHelp,
  askForHelp,
  helpContextLine,
  helpCountdownLine,
  helpView,
  isHelpCountdownTurn,
  logHelp,
  type HelpEvent,
} from "./help";
import {
  SECRET_PATTERN,
  newSecret,
  sha256,
  sweepCircleThrottled,
  type CircleMemberRecord,
  type CircleInviteRecord,
  type CircleMessageRecord,
  type DeviceRecord,
  type HelpRecord,
  type WalkerStore,
} from "./store";

/** How long a turn waits for the circle's people before going on without them. */
const CIRCLE_FOR_TURN_MS = 1_500;

/** What the walker says while a tool runs: one line per tool, so a new tool can't fall through to another's. */
const LOOKUP_LINE: Record<WalkerToolName, string> = {
  get_location: "I'll check your GPS location now.",
  get_weather: "I'll check the weather near you now.",
  get_distance: "I'll check the obstacle sensors now.",
  start_route: "Let me find that.",
  stop_route: "Stopping the directions.",
  show_on_screen: "Putting that on your screen.",
};
const isRouteTool = (name: string) => (ROUTE_TOOLS as readonly string[]).includes(name);
/** The model chose ask_for_help on a walker turn that can't ask (an older Pi, or the circle unreachable this turn). */
const HELP_UNAVAILABLE_LINE = "I can't ask anyone for help from here right now. If you need help now, call 911 from your phone.";

export class WalkerError extends Error {
  override readonly name = "WalkerError";
  constructor(
    readonly code: WalkerErrorCode,
    message: string,
    /** For `proposal_closed`: the proposal as it stands. */
    readonly proposal?: ProposalView,
    /** For `help_closed`: the help request as it stands. */
    readonly help?: HelpView,
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
  /** Turns a Talk clip into words before the model reads them (Cartesia); without it, spoken turns get a fixed line. */
  ears?: WalkerEars | null;
  /** The transcription's own limit (default TRANSCRIBE_TIMEOUT_MS). */
  transcribeTimeoutMs?: number;
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
  /** One event per help ask or answer from the walker (help.ts): ids, outcomes and timings, never names. */
  onHelp?: (event: HelpEvent) => void;
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
  /** Cartesia's transcription time; 0 when it wasn't asked. */
  transcribe_ms: number;
  voiced_by: "cartesia" | "walker" | null;
  voice_ms: number;
  proposal_opened: boolean;
  ms: number;
}

/**
 * One model step per request. The Pi gives it 10 s, so this 8 s budget leaves 2 s to download;
 * further tool steps use new requests under the same client_turn_id.
 */
const TURN_BUDGET_MS = 8_000;
const VOICE_TIMEOUT_MS = 3_000;
/** Cartesia's transcript of a clip of a few seconds; past this the turn answers with NOT_HEARD_LINE. */
const TRANSCRIBE_TIMEOUT_MS = 2_500;
/** A Talk press with no words made out. */
export const NOT_HEARD_LINE = "I didn't catch that. Please hold Talk and say it again.";
/** A Talk press the server couldn't transcribe (no Cartesia key, an error, or its time limit). */
export const CANT_HEAR_LINE = "I can't hear you right now. You can type your question on the walker's page.";
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
  private readonly ears: WalkerEars | null;
  private readonly transcribeTimeoutMs: number;
  private readonly voice: WalkerVoice | null;
  private readonly onTurn: (event: TurnEvent) => void;
  private readonly turnBudgetMs: number;
  private readonly voiceTimeoutMs: number;
  private readonly activity: ActivityLog | null;
  private readonly onHelp: (event: HelpEvent) => void;

  constructor(
    private readonly store: WalkerStore,
    options: WalkerServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.randomCode = options.randomCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
    this.blocked = options.blocked;
    this.assistant = options.assistant ?? null;
    this.ears = options.ears ?? null;
    this.transcribeTimeoutMs = options.transcribeTimeoutMs ?? TRANSCRIBE_TIMEOUT_MS;
    this.voice = options.voice ?? null;
    this.onTurn = options.onTurn ?? logTurn;
    this.turnBudgetMs = options.turnBudgetMs ?? TURN_BUDGET_MS;
    this.voiceTimeoutMs = options.voiceTimeoutMs ?? VOICE_TIMEOUT_MS;
    this.activity = options.activity ?? null;
    this.onHelp = options.onHelp ?? logHelp;
  }

  /** Voice a local Pi line with the same stock voice as replies. No model call or stored turn. */
  async deviceSpeech(caller: DeviceCaller, deviceId: string, text: string): Promise<DeviceSpeechResponse> {
    const device = await this.resolve(caller, deviceId);
    const audio = await this.speak(text, this.voiceTimeoutMs, () => {}, device.speech_pace);
    return { speech: audio ? { mime: "audio/wav", data_base64: audio } : null };
  }

  /** At server start: the store's migrations, then the history sweep. */
  async prepare(): Promise<void> {
    await this.begin();
    await this.sweep(this.now(), true);
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
      storable({ at: now.toISOString(), service_version: request.service_version, manifest: request.manifest, snapshot: request.snapshot, location: request.location, route: request.route, events }),
    );
    await this.sweep(now);
    const [configuration, proposal, latest] = await Promise.all([
      this.store.currentConfiguration(device.device_id),
      this.store.openProposal(device.device_id),
      this.store.deviceForOwner(device.device_id, device.owner_hash),
    ]);
    return HeartbeatResponseSchema.parse({ configuration_version: configuration.version, open_proposal: proposal ?? null, ...(latest?.location_sharing_enabled ? { location_sharing_enabled: true } : {}) });
  }

  async configuration(caller: DeviceCaller, deviceId: string): Promise<{ configuration: WalkerConfiguration }> {
    const device = await this.resolve(caller, deviceId);
    return { configuration: await this.store.currentConfiguration(device.device_id) };
  }

  // ---- The owner's page ----

  // A page can keep reading a walker that has stopped sending heartbeats, so page reads sweep old
  // history too, once per request, before building any view.

  async list(caller: OwnerCaller): Promise<{ walkers: WalkerStatusView[]; activity?: WalkerActivityView[]; speech_paces: { device_id: string; speech_pace: SpeechPace }[] }> {
    const owner = await this.owner(caller);
    const devices = await this.store.devicesForOwner(owner);
    await this.sweep(this.now());
    const walkers = await Promise.all(devices.map((d) => this.status(d)));
    // Page only, and only this owner's own walkers: the ids come from devicesForOwner, never the log.
    const activity = this.activity?.view(devices.map((d) => d.device_id)) ?? [];
    const speech_paces = devices.map((d) => ({ device_id: d.device_id, speech_pace: d.speech_pace }));
    return activity.length > 0 ? { walkers, activity, speech_paces } : { walkers, speech_paces };
  }

  /** The page's Slower / Normal / Faster: how fast Sophi talks in Cartesia's voice from the next line on. */
  async setSpeechPace(caller: OwnerCaller, deviceId: string, pace: SpeechPace): Promise<SpeechPaceResponse> {
    const device = await this.resolve(caller, deviceId);
    if (!(await this.store.writeSpeechPace(device.device_id, pace))) throw notFound();
    return { speech_pace: pace };
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
      // A countdown turn replayed (its answer was lost on the way): the Pi still has to count down.
      const askAgain = source === "walker" && prior.proposal === null && isHelpCountdownTurn(prior.turn);
      const response = WalkerTurnResponseSchema.parse({ ...prior, speech: null, status: await this.status(device), ...(askAgain ? { ask_for_help: true } : {}) });
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
    const flight = this.activity?.begin(device.device_id, { client_turn_id: request.client_turn_id, input: input.type, since: now.toISOString(), clip_ms: clipMs, model: this.assistant?.provider ?? null });
    try {
      return await this.answerTurn(device, source, request, now, started, left, clip, clipMs, flight);
    } finally {
      flight?.end();
    }
  }

  /** Cartesia's words for a clip: "" when none were made out, null when it couldn't be asked or failed in time. */
  private async transcribe(clip: Buffer, limitMs: number): Promise<string | null> {
    if (!this.ears || limitMs <= 0) return null;
    return this.ears.transcribe(clip, AbortSignal.timeout(Math.max(1, limitMs)));
  }

  private async answerTurn(
    device: DeviceRecord,
    source: "walker" | "page",
    request: DeviceTurnRequest | PageTurnRequest,
    now: Date,
    started: number,
    left: () => number,
    clip: Buffer | null,
    clipMs: number | null,
    flight: FlightHandle | undefined,
  ): Promise<WalkerTurnResponse> {
    const input = request.input;
    // A Talk press is heard first: Cartesia writes the words, and the model reads them like typed text.
    const transcribeStarted = Date.now();
    if (clip && this.ears) flight?.stage("transcribing");
    const transcript = clip ? await this.transcribe(clip, Math.min(this.transcribeTimeoutMs, left())) : null;
    const transcribeMs = clip && this.ears ? Date.now() - transcribeStarted : 0;
    if (clip) flight?.stage("hearing");
    // What she said, as the turn stores it: typed text, the continuation's original words, or the transcript.
    const heardText = input.type === "text" ? input.text : transcript || null;
    const spoken = input.type === "audio" || ("original_audio" in request && request.original_audio === true);
    const heardBy = heardText === null ? null : spoken ? ("cartesia" as const) : ("typed" as const);
    // A clip with no words, or one that couldn't be transcribed: a fixed line, and no model call.
    const unheard = input.type === "audio" && heardText === null ? (transcript === "" ? "not_heard" : "cant_hear") : null;
    // A walker's turn carries the snapshot it has at that moment, received now: it replaces the heartbeat's for this turn.
    const seen = "snapshot" in request ? { ...device, snapshot: request.snapshot, snapshot_received_at: request.snapshot ? now.toISOString() : null } : device;
    const status = await this.status(seen);
    const circle = await this.circleForTurn(device.device_id, now, source === "walker");
    const members = circle?.members ?? [];
    const recipients = members.filter((m) => m.state === "member" && m.role === "caregiver").map((m) => ({ member_id: m.member_id, name: m.name }));
    // The tool is offered on her own Talk turns from a walker that can count down, once the circle is known (with no
    // caretaker it answers with the fixed no-caretaker line). Never on the owner's page.
    const canAsk = source === "walker" && "can_ask_for_help" in request && request.can_ask_for_help === true;
    const help = { offer: canAsk && circle !== null, open: source === "walker" && circle?.help ? helpContextLine(circle.help) : null };
    // A spoken turn, continued after a tool or not, stays spoken: the model must not answer it as typed ("use Talk").
    const words: Words = { type: "text", text: heardText ?? "", ...(spoken ? { spoken: true } : {}) };
    const toolResults: WalkerToolResult[] = "tool_results" in request
      ? (request.tool_results ?? []).map((r) => r.name === "get_distance" ? { name: r.name, text: distanceLine(status) } : r)
      : [];
    // Only a walker turn that carries `navigation` is offered the route tools, and at most one runs per turn.
    const navigation = source === "walker" && "navigation" in request ? request.navigation : undefined;
    const routeDone = toolResults.some((r) => isRouteTool(r.name));
    // Only a walker turn that carries `screen` is offered show_on_screen, and only with the views it lists.
    const screenViews = source === "walker" && "screen" in request ? (request.screen?.views ?? []) : [];
    const assistant = unheard ? null : this.assistant;
    const result = assistant ? await assistant.reply(status, source, words, now, Math.min(WALKER_TIMEOUT_MS, left()), undefined, toolResults, recipients, navigation, help, screenViews, device.speech_pace) : null;

    const toolCall = result?.ok && !result.reply.topics.includes("arms") && !result.reply.cues_change ? result.reply.tool_call : null;
    const tool = toolCall?.name;
    const routeTool = tool !== undefined && isRouteTool(tool);
    const unlistedView = toolCall?.name === "show_on_screen" && !screenViews.includes(toolCall.view);
    const nextTool = source === "walker" && tool && tool !== "send_message" && tool !== "ask_for_help" && tool !== "set_lift_height" && tool !== "move_lift" && tool !== "reset_lift_position" && !unlistedView && toolResults.length < WALKER_MAX_TOOL_CALLS && !routeDone && (!routeTool || navigation) ? tool : null;
    if (nextTool) {
      const line = LOOKUP_LINE[nextTool];
      if (nextTool === "get_distance") toolResults.push({ name: "get_distance", text: distanceLine(status) });
      const speech = await this.speak(line, left(), () => flight?.stage("voicing"), device.speech_pace);
      return WalkerTurnResponseSchema.parse({
        turn: { turn_id: this.randomId(), client_turn_id: request.client_turn_id, source: "walker", heard: heardText, heard_by: heardBy, reply: line, answered_by: "fixed", voiced_by: speech ? "cartesia" : "walker", created_at: now.toISOString() },
        proposal: null,
        speech: speech ? { mime: "audio/wav", data_base64: speech } : null,
        status,
        tool_call: toolCall?.name === "start_route" ? { name: toolCall.name, destination: toolCall.destination } : toolCall?.name === "show_on_screen" ? { name: toolCall.name, view: toolCall.view } : { name: nextTool },
        tool_results: toolResults,
      });
    }
    // After a card the walker showed (a sensors card included), the model answers from that result.
    const distanceLookup = result?.ok && result.reply.topics.includes("obstacles") && !result.reply.topics.includes("arms") && !result.reply.cues_change && !toolResults.some((r) => r.name === "get_distance" || r.name === "show_on_screen");
    const motionOffer = source === "walker" && !status.open_proposal
      ? toolCall?.name === "set_lift_height" ? { preset: toolCall.preset }
        : toolCall?.name === "move_lift" ? { delta_mm: toolCall.direction === "up" ? toolCall.distance_mm : -toolCall.distance_mm }
        : toolCall?.name === "reset_lift_position" ? { reference_mm: toolCall.position_mm }
        : null
      : null;
    const messageRecipient = source === "walker" && toolCall?.name === "send_message" ? recipients.find((r) => r.member_id === toolCall.to_member_id) : undefined;
    const validMessage = messageRecipient && toolCall?.name === "send_message" ? DeviceSendMessageRequestSchema.safeParse({ client_message_id: this.randomId(), to_member_id: messageRecipient.member_id, text: toolCall.text }) : null;
    const canSend = members.some((m) => m.role === "walker_user" && m.state === "member");
    const messageOffer = validMessage?.success && messageRecipient && !status.open_proposal && canSend ? { ...validMessage.data, to_name: messageRecipient.name } : null;
    const unhandledTool = tool !== null && tool !== undefined;
    // Asking for help: the server words the reply, and the Pi counts down and asks itself. Nothing is created here.
    const caretakerNames = recipients.map((r) => r.name);
    const helpAsked = tool === "ask_for_help" && help.offer && caretakerNames.length > 0;
    const decided = unheard
      ? { reply: unheard === "not_heard" ? NOT_HEARD_LINE : CANT_HEAR_LINE, answered_by: "fixed" as const, reason: unheard, proposal: null }
      : tool === "ask_for_help"
      ? helpAsked
        ? { reply: helpCountdownLine(caretakerNames), answered_by: "fixed" as const, reason: "ask_for_help", proposal: null }
        : help.offer
          ? { reply: NO_CARETAKER_VOICE_LINE, answered_by: "fixed" as const, reason: "no_caretaker", proposal: null }
          : source === "page"
            ? { reply: "Please use Talk on the walker for that request.", answered_by: "fixed" as const, reason: "device_tool_only", proposal: null }
            : { reply: HELP_UNAVAILABLE_LINE, answered_by: "fixed" as const, reason: "help_not_offered", proposal: null }
      : motionOffer
      ? { reply: "I'll check the lift now.", answered_by: "fixed" as const, reason: "lift_offer", proposal: null }
      : messageOffer
      ? { reply: `Send to ${messageOffer.to_name}: ${messageOffer.text}. Press Confirm to send.`, answered_by: "model" as const, reason: "message_offer", proposal: null }
      : source === "page" && tool === "get_distance"
        ? { reply: distanceLine(status), answered_by: "fixed" as const, reason: "distance_guard", proposal: null }
      : source === "page" && (tool === "get_location" || tool === "get_weather" || tool === "send_message" || tool === "set_lift_height" || tool === "move_lift" || tool === "reset_lift_position" || tool === "show_on_screen" || routeTool)
        ? { reply: "Please use Talk on the walker for that request.", answered_by: "fixed" as const, reason: "device_tool_only", proposal: null }
      : routeTool && !navigation
        ? { reply: "I can't give walking directions on this walker.", answered_by: "fixed" as const, reason: "route_unavailable", proposal: null }
      : unlistedView
        ? { reply: "I can't show that on this walker's screen right now.", answered_by: "fixed" as const, reason: "show_unavailable", proposal: null }
      : tool === "send_message"
        ? { reply: "I couldn't prepare that message. Check that both phones have joined your circle and try again.", answered_by: "fixed" as const, reason: "message_unavailable", proposal: null }
      : unhandledTool
      ? { reply: "I couldn't finish checking all of that right now.", answered_by: "fixed" as const, reason: routeDone ? "route_once" : "tool_limit", proposal: null }
      : distanceLookup
        ? { reply: distanceLine(status), answered_by: "fixed" as const, reason: "distance_guard", proposal: null }
        : applyRules(status, device.manifest, result, () => this.randomId(), request.client_turn_id, now, { now: device.speech_pace, voice: this.voice !== null });
    // A pace change is in force for this reply already, so she hears the change itself.
    const pace = "speech_pace" in decided && decided.speech_pace ? decided.speech_pace : device.speech_pace;
    if (!messageOffer && decided.answered_by === "model" && toolResults.some((r) => (r.name === "get_weather" || r.name === "show_on_screen") && r.text.includes("Weather data from Open-Meteo.")) && !decided.reply.includes("Open-Meteo")) {
      decided.reply += " Weather data from Open-Meteo.";
    }
    const heard = { heard: heardText, heard_by: heardBy };

    const voiceStarted = Date.now();
    let voiceCalled = false;
    const speech =
      source === "walker" && !motionOffer
        ? await this.speak(decided.reply, left(), () => {
            voiceCalled = true;
            flight?.stage("voicing");
          }, pace)
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
    // Only the upload that saved the turn changes the pace; a second upload of it or a replay changes nothing.
    if (saved.created && pace !== device.speech_pace) await this.store.writeSpeechPace(device.device_id, pace);
    // The status read expires proposals (say the walker went offline during the turn), so read the
    // proposal after it: the response never calls a proposal open that isn't.
    const after = await this.status(device);
    const stored = await this.store.findTurn(device.device_id, request.client_turn_id);
    // Another upload of this turn saved first: its turn and proposal are the answer, without this one's audio.
    const proposal = stored?.proposal ?? saved.proposal;
    // Another upload that saved first is answered as a replay is: a countdown turn still counts down.
    const askNow = saved.created ? helpAsked : source === "walker" && proposal === null && isHelpCountdownTurn(saved.turn);
    const response = WalkerTurnResponseSchema.parse({
      turn: saved.turn,
      proposal,
      speech: saved.created && speech ? { mime: "audio/wav", data_base64: speech } : null,
      status: after,
      ...(saved.created && messageOffer && !helpAsked ? { message_offer: messageOffer } : {}),
      ...(saved.created && motionOffer ? { motion_offer: motionOffer } : {}),
      ...(askNow ? { ask_for_help: true } : {}),
    });
    const event: TurnEvent = {
      ...turnEvent(device.device_id, source, input.type, saved.turn),
      replayed: !saved.created,
      reason: decided.reason,
      attempts: result?.attempts ?? 0,
      model: result?.model ?? null,
      model_ms: result?.ms ?? 0,
      transcribe_ms: transcribeMs,
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
        model: event.attempts > 0 ? (result?.provider ?? null) : null,
        model_ms: event.attempts > 0 ? event.model_ms : null,
        transcribe_ms: input.type === "audio" && this.ears ? transcribeMs : null,
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
  private async speak(text: string, leftMs: number, onCall: () => void, pace: SpeechPace): Promise<string | null> {
    const ms = Math.min(this.voiceTimeoutMs, leftMs);
    if (!this.voice || ms < VOICE_MIN_MS) return null;
    onCall();
    return this.voice.speak(text, AbortSignal.timeout(ms), pace).catch(() => null);
  }

  /** Called by the paired Pi only after it read a draft aloud and received a fresh Confirm press. */
  async sendMessage(caller: DeviceCaller, deviceId: string, request: DeviceSendMessageRequest): Promise<{ sent: true }> {
    const device = await this.resolve(caller, deviceId);
    const body = DeviceSendMessageRequestSchema.parse(request);
    const now = this.now();
    const { members } = await this.store.circleOf(device.device_id, now);
    const from = members.find((m) => m.role === "walker_user" && m.state === "member");
    const to = members.find((m) => m.member_id === body.to_member_id && m.role === "caregiver" && m.state === "member");
    if (!from || !to) throw new WalkerError("invalid_request", "The approved sender or recipient phone is unavailable.");
    const record: CircleMessageRecord = storable({
      message_id: this.randomId(), device_id: device.device_id, client_message_id: body.client_message_id,
      from_member_id: from.member_id, to_member_id: to.member_id, text: body.text,
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + CIRCLE_MESSAGE_RETENTION_MS).toISOString(),
    });
    const saved = await this.store.saveMessage(record, MAX_LIVE_MESSAGES, now);
    if (!saved || saved === "cleared") throw new WalkerError("invalid_request", "This message can no longer be sent.");
    return { sent: true };
  }

  /**
   * For the paired Pi, after each heartbeat: the newest messages an approved caretaker sent to her phone, which
   * her walker reads aloud in its own voice. Never sent to a model or the voice service, and never logged.
   */
  async incomingMessages(caller: DeviceCaller, deviceId: string): Promise<DeviceMessagesResponse> {
    const device = await this.resolve(caller, deviceId);
    const now = this.now();
    const { members, invites } = await this.store.circleOf(device.device_id, now);
    const her = members.find((m) => m.role === "walker_user" && m.state === "member");
    let ownInvite = invites.find((i) => i.role === "walker_user" && Date.parse(i.expires_at) > now.getTime());
    if (!her && !ownInvite) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const invite: CircleInviteRecord = storable({
          invite_id: this.randomId(), device_id: device.device_id, code: this.randomCode(),
          name: "Sophi owner", role: "walker_user", created_at: now.toISOString(),
          expires_at: new Date(now.getTime() + CIRCLE_INVITE_TTL_MS).toISOString(),
        });
        const result = await this.store.putInvite(invite, { maxOpen: MAX_OPEN_INVITES, maxMembers: MAX_CIRCLE_MEMBERS }, now);
        if (result === "ok") { ownInvite = invite; break; }
        if (result !== "code_taken") break;
      }
    }
    const companion_code = ownInvite ? { code: ownInvite.code, expires_at: ownInvite.expires_at } : null;
    if (!her) return DeviceMessagesResponseSchema.parse({ messages: [], companion_code });
    const caretakers = new Map(members.filter((m) => m.role === "caregiver" && m.state === "member").map((m) => [m.member_id, m.name]));
    const toHer = (await this.store.messagesFor(device.device_id, her.member_id, now)).filter(
      (m) => m.to_member_id === her.member_id && caretakers.has(m.from_member_id),
    );
    return DeviceMessagesResponseSchema.parse({
      companion_code,
      messages: toHer.slice(-WALKER_MESSAGES_KEPT).map((m) => ({ message_id: m.message_id, from_name: caretakers.get(m.from_member_id), text: m.text })),
    });
  }

  // ---- Asking for help from the walker (docs/subsystems/help.md; the phones' routes are in CircleService) ----

  /**
   * The walker asks: both handle buttons held, or the voice countdown reached zero. `created` picks 201 or 200.
   * Asking while one is open returns it and keeps this client_help_id for it, so a retry never opens a second.
   */
  async askForHelp(caller: DeviceCaller, deviceId: string, request: DeviceAskForHelpRequest): Promise<{ created: boolean; response: HelpResponse }> {
    const device = await this.helpDevice(caller, deviceId);
    const now = this.now();
    const result = await askForHelp(
      this.store,
      { help_id: this.randomId(), device_id: device.device_id, client_help_id: request.client_help_id, source: request.source, asked_by_member_id: null },
      now,
      this.onHelp,
    );
    if (result.outcome === "no_caretaker") throw new WalkerError("no_caretaker", NO_CARETAKER_MESSAGE);
    // Forgotten between finding the walker and the ask.
    if (result.outcome === "not_found") throw notFound();
    return { created: result.outcome === "created", response: HelpResponseSchema.parse({ help: helpView(result.help, now) }) };
  }

  /** The walker's poll: its open request, or the newest closed within HELP_CLOSED_SHOWN_MS, or null. */
  async help(caller: DeviceCaller, deviceId: string): Promise<DeviceHelpStatusResponse> {
    const device = await this.helpDevice(caller, deviceId);
    const now = this.now();
    const help = await this.store.helpOf(device.device_id, now);
    return DeviceHelpStatusResponseSchema.parse({ help: help ? helpView(help, now) : null });
  }

  /** Her second lone Confirm on the walker: closes it `okay`, by her phone if it is in, else by nobody. */
  async helpOkay(caller: DeviceCaller, deviceId: string, helpId: string): Promise<HelpResponse> {
    const device = await this.helpDevice(caller, deviceId);
    const now = this.now();
    const result = await answerHelp(this.store, device.device_id, helpId, { kind: "close", how: "okay", member_id: null }, "walker", now, this.onHelp);
    if (result.outcome === "not_found" || result.outcome === "not_member") throw new WalkerError("not_found", HELP_NOT_FOUND_MESSAGE);
    const view = HelpResponseSchema.parse({ help: helpView(result.help, now) });
    if (result.outcome === "closed") throw new WalkerError("help_closed", HELP_CLOSED_MESSAGE, undefined, view.help);
    return view;
  }

  /** The walker by its credential, then the circle's throttled sweep (so expired requests are deleted as messages are). */
  private async helpDevice(caller: DeviceCaller, deviceId: string): Promise<DeviceRecord> {
    const device = await this.resolve(caller, deviceId);
    await sweepCircleThrottled(this.store, this.now());
    return device;
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

  /** The walker's history sweep, then the circle's (at most once a minute; always at server start). */

  /**
   * The circle for one turn's recipients. A turn never fails, and never waits more than CIRCLE_FOR_TURN_MS,
   * because of the circle (it may live in SpacetimeDB, apart from the walker): without it the turn just has
   * no one to message.
   */
  private async circleForTurn(deviceId: string, now: Date, withHelp: boolean): Promise<{ members: CircleMemberRecord[]; help: HelpRecord | null } | null> {
    // Her open help request only on her own walker turns (the model's one line); never on the owner's page.
    const read = async () => {
      const [circle, help] = await Promise.all([this.store.circleOf(deviceId, now), withHelp ? this.store.helpOf(deviceId, now) : null]);
      return { members: circle.members, help };
    };
    // Only a circle kept apart from the walker (SpacetimeCircleStore, found by shape) gets the deadline and the
    // fallback; with the walker's own store, the turn reads its circle as before.
    if (!("pingCare" in this.store)) return await read();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("circle_timeout")), CIRCLE_FOR_TURN_MS)));
      return await Promise.race([read(), late]);
    } catch (error) {
      console.warn(`[walker] turn without the circle (${error instanceof Error ? error.message.slice(0, 80) : "unknown"})`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  private async sweep(now: Date, atStart = false) {
    await this.store.sweep(now, new Date(now.getTime() - WALKER_HISTORY_RETENTION_MS), new Date(now.getTime() - PAIRING_LOCK_WINDOW_MS));
    await sweepCircleThrottled(this.store, now, atStart);
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
 * The server's rules for a reply, all from structured fields (the model's topics, cues_change and speech_pace, the
 * status view, the manifest), never from words: what the person hears, who answered, any proposal to open, and a
 * new speaking pace. `pace`: the walker's pace now, and whether this server has Cartesia's voice to apply one.
 */
export function applyRules(
  status: WalkerStatusView,
  manifest: DeviceRecord["manifest"],
  result: AssistantResult | null,
  newId: () => string,
  clientTurnId: string,
  now: Date,
  pace: { now: SpeechPace; voice: boolean },
): { reply: string; answered_by: "model" | "fixed"; reason: string | null; proposal: ProposalView | null; speech_pace?: SpeechPace } {
  if (!result?.ok) return { reply: withReminder(fallbackLine(status), status), answered_by: "fixed", reason: result?.reason ?? "no_model", proposal: null };
  const out = result.reply;
  // An empty reply is valid only beside ask_for_help; when the turn didn't take it (no words were made out), say
  // the fixed line rather than nothing.
  if (out.reply.length === 0 && !out.topics.includes("arms") && !out.cues_change && !out.speech_pace) {
    return { reply: withReminder(fallbackLine(status), status), answered_by: "fixed", reason: "empty_reply", proposal: null };
  }
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
  if (out.speech_pace) {
    const next = out.speech_pace;
    if (!pace.voice) return { reply: withReminder(PACE_NO_VOICE, status), answered_by: "fixed", reason: "pace_no_voice", proposal: null };
    if (next === pace.now) return { reply: withReminder(PACE_UNCHANGED[next], status), answered_by: "fixed", reason: "pace_unchanged", proposal: null };
    return { reply: withReminder(PACE_CHANGED[next], status), answered_by: "fixed", reason: `pace_${next}`, proposal: null, speech_pace: next };
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
    transcribe_ms: 0,
    voiced_by: turn.voiced_by,
    voice_ms: 0,
    proposal_opened: false,
    ms: 0,
  };
}

function logTurn(e: TurnEvent) {
  console.info(
    `[walker] turn device=${e.device_id} source=${e.source} input=${e.input} replayed=${e.replayed} answered_by=${e.answered_by} reason=${e.reason ?? "none"} attempts=${e.attempts} transcribe_ms=${e.transcribe_ms} model=${e.model ?? "none"} model_ms=${e.model_ms} voiced_by=${e.voiced_by ?? "none"} voice_ms=${e.voice_ms} proposal=${e.proposal_opened} ms=${e.ms}`,
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
