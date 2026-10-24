import { createHmac, randomBytes, randomInt } from "node:crypto";
import {
  AnswerProposalResponseSchema,
  HeartbeatResponseSchema,
  MAX_WALKERS_PER_OWNER,
  PAIRING_CODE_TTL_MS,
  PAIRING_LOCK_WINDOW_MS,
  PAIRING_MAX_WRONG,
  RECENT_TURNS,
  WALKER_ERROR_STATUS,
  WALKER_HISTORY_RETENTION_MS,
  WALKER_SETUP,
  type AnswerProposalRequest,
  type AnswerProposalResponse,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type PairDeviceRequest,
  type PairDeviceResponse,
  type PairingCodeResponse,
  type ProposalView,
  type WalkerConfiguration,
  type WalkerErrorCode,
  type WalkerStatusView,
} from "@walker/contracts";
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
}

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

  constructor(
    private readonly store: WalkerStore,
    options: WalkerServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.randomCode = options.randomCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
    this.blocked = options.blocked;
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

  async list(caller: OwnerCaller): Promise<{ walkers: WalkerStatusView[] }> {
    const owner = await this.owner(caller);
    const devices = await this.store.devicesForOwner(owner);
    await this.sweep(this.now());
    return { walkers: await Promise.all(devices.map((d) => this.status(d))) };
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
  }

  // ---- Both ----

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

function notFound() {
  return new WalkerError("not_found", "This walker wasn't found. It may have been forgotten.");
}

function unpaired() {
  return new WalkerError("unauthenticated", "This walker isn't paired. Pair it again from the Your walker page.");
}

function limitError() {
  return new WalkerError("walker_limit", `This browser already has ${MAX_WALKERS_PER_OWNER} walkers. Forget one before pairing another.`);
}
