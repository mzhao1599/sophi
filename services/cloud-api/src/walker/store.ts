import { createHash, randomBytes } from "node:crypto";
import type {
  CapabilityManifest,
  PhoneRole,
  ProposalView,
  SensorSnapshot,
  WalkerConfiguration,
  WalkerEventView,
  WalkerTurnView,
} from "@walker/contracts";
import { CIRCLE_ITEM_RETENTION_MS, LOCATION_FIX_MAX_AGE_MS } from "@walker/contracts";
import { decideAnswer, shouldExpire, type Answer } from "./rules";

/**
 * Where paired walkers live. Two implementations: MemoryWalkerStore (below) for local runs and tests,
 * and PostgresWalkerStore (postgres-store.ts). Both enforce ownership in every read and write: a
 * device is found only by its credential hash (the Pi) or by its id together with its owner hash (the
 * page), and everything else hangs off a device id found that way. Times are always passed in, so a
 * test can run the clock forward without sleeping.
 */

export interface DeviceRecord {
  device_id: string;
  owner_hash: string;
  name: string;
  service_version: string;
  created_at: string;
  last_heartbeat_at: string | null;
  manifest: CapabilityManifest | null;
  snapshot: SensorSnapshot | null;
  /** The server's clock when it received `snapshot`. */
  snapshot_received_at: string | null;
  location_sharing_enabled: boolean;
  location: { latitude: number; longitude: number } | null;
  location_received_at: string | null;
}

/** The owner comes from the pairing code it claims. */
export interface NewDevice {
  device_id: string;
  credential_hash: string;
  name: string;
  service_version: string;
  created_at: string;
}

export interface PairingCode {
  code: string;
  owner_hash: string;
  created_at: string;
  expires_at: string;
}

/** One pairing attempt: the code, the device it would create, and the lockout it is checked against. */
export interface PairingClaim {
  code: string;
  now: Date;
  device: NewDevice;
  configuration: WalkerConfiguration;
  maxDevices: number;
  /** A keyed hash of the client address, never the address. */
  address_key: string;
  /** Wrong codes from this address after `triesSince` count towards the lockout. */
  triesSince: Date;
  maxWrong: number;
}

export type ClaimResult =
  | { ok: true; device: DeviceRecord; configuration: WalkerConfiguration }
  /** `busy`: another claim from the same address is running (Postgres answers at once rather than wait). */
  | { ok: false; reason: "locked" | "busy" | "code_invalid" | "walker_limit" };

export type AnswerResult =
  | { outcome: "answered"; proposal: ProposalView }
  /** It wasn't open (or stopped being open at this moment): the proposal as it now stands. */
  | { outcome: "closed"; proposal: ProposalView }
  | { outcome: "not_found" };

export interface Heartbeat {
  at: string;
  service_version: string;
  manifest: CapabilityManifest;
  snapshot: SensorSnapshot | null;
  location?: { latitude: number; longitude: number; age_ms: number };
  /** Placed in time by the service; ones already stored (same event_id) are ignored. */
  events: WalkerEventView[];
}

export interface SavedTurn {
  turn: WalkerTurnView;
  /** The proposal this turn opened, as it stands now. */
  proposal: ProposalView | null;
  /** False when a turn with this client_turn_id was already stored; nothing new was written. */
  created: boolean;
}

// ---- The two-phone circle (migration 0003) ----

export interface CircleMemberRecord {
  member_id: string;
  device_id: string;
  name: string;
  role: PhoneRole;
  /** `waiting`: a caretaker whose join the owner hasn't approved yet. */
  state: "waiting" | "member";
  created_at: string;
  /** When a waiting caretaker's join lapses; null once a member. */
  expires_at: string | null;
  joined_at: string | null;
}

export interface CircleInviteRecord {
  invite_id: string;
  device_id: string;
  code: string;
  name: string;
  role: PhoneRole;
  created_at: string;
  expires_at: string;
}

export interface CircleMessageRecord {
  message_id: string;
  device_id: string;
  client_message_id: string;
  from_member_id: string;
  to_member_id: string;
  text: string;
  created_at: string;
  expires_at: string;
}

/** `walker_user_taken`: her own phone is already in (only one per walker). */
export type PutInviteResult = "ok" | "code_taken" | "circle_full" | "walker_user_taken";

/** One join attempt: the code, the member it would create, and the lockout it is checked against (as pairing). */
export interface InviteClaim {
  code: string;
  now: Date;
  /** `replaces_member_id`: this browser's earlier membership, removed once the new one is in. */
  member: { member_id: string; secret_hash: string; created_at: string; replaces_member_id: string | null };
  /** When a caretaker's wait for the owner's approval ends. Her own phone joins at once. */
  waitingUntil: string;
  maxMembers: number;
  address_key: string;
  triesSince: Date;
  maxWrong: number;
}

export type InviteClaimResult =
  | { ok: true; member: CircleMemberRecord }
  | { ok: false; reason: "locked" | "busy" | "code_invalid" | "circle_full" | "walker_user_taken" };

/**
 * The circle's storage. Every read and write names the device id the service already resolved (by the
 * owner's hash, or from the member found by its cookie's hash), so one walker's circle never reaches another's.
 */
export interface CircleStore {
  /**
   * In one step: drops this walker's expired invites; refuses `circle_full` at `maxOpen` open invites or
   * `maxMembers` people (members and caretakers still waiting); for her own phone, refuses
   * `walker_user_taken` when it is already in, and replaces an earlier open invite for it; refuses
   * `code_taken` when a live invite has the same digits; otherwise saves it.
   */
  putInvite(invite: CircleInviteRecord, limits: { maxOpen: number; maxMembers: number }, now: Date): Promise<PutInviteResult>;
  /** Members and waiting caretakers (lapsed ones too) in the order they joined, and open invites, oldest first. */
  circleOf(deviceId: string, now: Date): Promise<{ members: CircleMemberRecord[]; invites: CircleInviteRecord[] }>;
  /**
   * In one step per client address, as claimPairingCode: `locked` past the wrong-code limit; a live code is
   * used up and its member made (waiting for a caretaker, in at once for her own phone); a wrong or expired
   * code is recorded as a wrong try. A full circle or her phone already in leaves the code usable.
   */
  claimInvite(claim: InviteClaim): Promise<InviteClaimResult>;
  memberBySecret(secretHash: string): Promise<CircleMemberRecord | undefined>;
  /** The walker a member belongs to (found from the member, never from a caller's id). */
  circleDevice(deviceId: string): Promise<DeviceRecord | undefined>;
  /**
   * In one step: a caretaker still waiting at `now` becomes a member, and the membership it replaces (the
   * same browser's earlier one) is removed with its messages. One already a member comes back as it is.
   * Undefined when it is gone or lapsed.
   */
  approveJoin(deviceId: string, memberId: string, now: Date): Promise<CircleMemberRecord | undefined>;
  /** Deletes the member (or waiting caretaker) and every message to or from them, at once. */
  removeMember(deviceId: string, memberId: string): Promise<boolean>;
  /**
   * In one step: a message with this sender's client_message_id already kept comes back unchanged
   * (`created: false`), or `cleared` when the limit has since cleared it; otherwise, with both phones still
   * members, it is saved, and this walker's messages beyond its newest `maxLive` are cleared (text deleted,
   * a short record kept until they expire, so a retry isn't saved again). Null when the sender or the
   * recipient isn't a member of this walker any more.
   */
  saveMessage(message: CircleMessageRecord, maxLive: number, now: Date): Promise<{ message: CircleMessageRecord; created: boolean } | "cleared" | null>;
  /** Unexpired, uncleared messages to or from this member, oldest first. */
  messagesFor(deviceId: string, memberId: string, now: Date): Promise<CircleMessageRecord[]>;
  /** Deletes expired invites and messages, and caretakers' joins that lapsed before `lapsedBefore`. */
  sweepCircle(now: Date, lapsedBefore: Date): Promise<void>;
}

/** The circle's sweep runs at most this often per server process and store. */
export const CIRCLE_SWEEP_EVERY_MS = 60_000;
const lastCircleSweep = new WeakMap<object, number>();

/**
 * The circle's deletion sweep, at most once per CIRCLE_SWEEP_EVERY_MS for each store in this process
 * (`force` at server start). A clock that went backwards (a test's) sweeps again. Called from the walker's
 * own sweep, so rows are deleted even when no phone or owner asks, and from circle requests only after
 * the caller has been found, so a forged cookie can't make the server sweep.
 */
export async function sweepCircleThrottled(store: CircleStore, now: Date, force = false): Promise<void> {
  const last = lastCircleSweep.get(store);
  const t = now.getTime();
  if (!force && last !== undefined && t >= last && t - last < CIRCLE_SWEEP_EVERY_MS) return;
  lastCircleSweep.set(store, t);
  await store.sweepCircle(now, new Date(t - CIRCLE_ITEM_RETENTION_MS));
}

export interface WalkerStore extends CircleStore {
  /** Prepares the store: Postgres runs its migrations. Safe to call again. */
  ready(): Promise<void>;
  /** Throws when the store can't be reached now (Postgres: one `select 1`). */
  ping(): Promise<void>;

  /** Saves a code, replacing the owner's earlier ones. False, saving nothing, when a live code has the same digits. */
  putPairingCode(code: PairingCode, now: Date): Promise<boolean>;
  countDevices(ownerHash: string): Promise<number>;
  /**
   * In one step per client address, so tries sent at once can't all get past the lockout: an address
   * with `maxWrong` wrong codes since `triesSince` gets `locked` (nothing else is checked or recorded);
   * otherwise a live code is used up and its owner's device created with configuration version 1, and
   * a wrong or expired code is recorded as a wrong try. An owner already at `maxDevices` gets
   * `walker_limit`, and the code stays usable.
   */
  claimPairingCode(claim: PairingClaim): Promise<ClaimResult>;

  deviceByCredential(credentialHash: string): Promise<DeviceRecord | undefined>;
  deviceForOwner(deviceId: string, ownerHash: string): Promise<DeviceRecord | undefined>;
  devicesForOwner(ownerHash: string): Promise<DeviceRecord[]>;

  recordHeartbeat(deviceId: string, heartbeat: Heartbeat): Promise<void>;
  /** Recheck the approved walker user's membership at write time; disabling clears the fix atomically. */
  setLocationSharing(deviceId: string, memberId: string, enabled: boolean): Promise<boolean>;
  /**
   * Sets the walker's sharing and erases its fix, with no membership check: for a store whose circle lives
   * elsewhere (SpacetimeCircleStore), which checks her membership there first. False if there's no such walker.
   */
  writeLocationSharing(deviceId: string, enabled: boolean): Promise<boolean>;
  currentConfiguration(deviceId: string): Promise<WalkerConfiguration>;
  /** Marks the open proposal expired if it is past its expiry or the walker is offline at `now`. */
  expireProposals(deviceId: string, now: Date): Promise<void>;
  openProposal(deviceId: string): Promise<ProposalView | undefined>;
  /** The newest `limit`, oldest first. */
  recentTurns(deviceId: string, limit: number): Promise<WalkerTurnView[]>;
  recentLines(deviceId: string, limit: number): Promise<WalkerEventView[]>;

  /** Answers one proposal by id in one atomic step (rules.ts decides): the first answer wins. */
  answerProposal(deviceId: string, proposalId: string, answer: Answer, now: Date): Promise<AnswerResult>;
  /** A stored turn by its client_turn_id, with the proposal it opened as that stands now. */
  findTurn(deviceId: string, clientTurnId: string): Promise<{ turn: WalkerTurnView; proposal: ProposalView | null } | undefined>;
  /**
   * Stores a turn and, when it opened one, its proposal, in one step: an open proposal that has expired
   * by `now` is marked expired, and one still open is superseded. A client_turn_id already stored
   * returns that turn and its proposal instead, so a retry never opens a second. Null when the walker
   * no longer exists (forgotten during the turn).
   */
  saveTurn(deviceId: string, turn: WalkerTurnView, proposal: ProposalView | null, now: Date): Promise<SavedTurn | null>;

  /** Deletes turns, walker lines and closed proposals from before `historySince`, expired codes and old wrong tries. */
  sweep(now: Date, historySince: Date, triesSince: Date): Promise<void>;
  /** Deletes the device and everything about it at once, revoking its credential. False if it isn't the owner's. */
  forget(deviceId: string, ownerHash: string): Promise<boolean>;
}

/** 32 random bytes as base64url (43 characters): an owner cookie or a device credential. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** SHA-256 as hex. Secrets have 256 random bits, so no salt is needed. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface MemoryDevice extends DeviceRecord {
  credential_hash: string;
  configurations: WalkerConfiguration[];
  proposals: ProposalView[];
  turns: { turn: WalkerTurnView; proposal_id: string | null }[];
  lines: WalkerEventView[];
  members: MemoryMember[];
  invites: CircleInviteRecord[];
  /** Oldest first. A cleared one has no text left and is kept only until it expires. */
  messages: (CircleMessageRecord & { cleared: boolean })[];
}

type MemoryMember = CircleMemberRecord & { secret_hash: string; replaces_member_id: string | null };

/** In the circle at `now`: a member, or a caretaker whose join hasn't lapsed. */
function counts(m: CircleMemberRecord, now: Date): boolean {
  return m.state === "member" || (m.expires_at !== null && ms(m.expires_at) > now.getTime());
}

function publicMember({ secret_hash: _hash, replaces_member_id: _replaces, ...member }: MemoryMember): CircleMemberRecord {
  return { ...member };
}

function publicMessage({ cleared: _cleared, ...message }: CircleMessageRecord & { cleared: boolean }): CircleMessageRecord {
  return { ...message };
}

const ms = (iso: string) => Date.parse(iso);
const copy = <T>(value: T): T => structuredClone(value);

/**
 * In-memory store. Lost on restart, and not shared between server instances, so it is for local runs
 * and tests; production uses Postgres (walkerBackendFromEnv). Each method finishes its check and its
 * change with no `await` in between, so concurrent requests see each step as atomic.
 */
export class MemoryWalkerStore implements WalkerStore {
  private readonly devices = new Map<string, MemoryDevice>();
  private readonly codes = new Map<string, PairingCode>();
  private readonly wrongTries: { address_key: string; at: string }[] = [];

  async ready() {}
  async ping() {}

  async putPairingCode(code: PairingCode, now: Date) {
    const taken = this.codes.get(code.code);
    if (taken && ms(taken.expires_at) > now.getTime()) return false;
    for (const [digits, c] of this.codes) if (c.owner_hash === code.owner_hash) this.codes.delete(digits);
    this.codes.set(code.code, { ...code });
    return true;
  }

  async countDevices(ownerHash: string) {
    return [...this.devices.values()].filter((d) => d.owner_hash === ownerHash).length;
  }

  async claimPairingCode({ code, now, device, configuration, maxDevices, address_key, triesSince, maxWrong }: PairingClaim): Promise<ClaimResult> {
    const wrong = this.wrongTries.filter((t) => t.address_key === address_key && ms(t.at) > triesSince.getTime()).length;
    if (wrong >= maxWrong) return { ok: false, reason: "locked" };
    const found = this.codes.get(code);
    if (!found || ms(found.expires_at) <= now.getTime()) {
      this.wrongTries.push({ address_key, at: now.toISOString() });
      return { ok: false, reason: "code_invalid" };
    }
    const owned = [...this.devices.values()].filter((d) => d.owner_hash === found.owner_hash).length;
    if (owned >= maxDevices) return { ok: false, reason: "walker_limit" };
    this.codes.delete(code);
    const record: MemoryDevice = {
      ...device,
      owner_hash: found.owner_hash,
      last_heartbeat_at: null,
      manifest: null,
      snapshot: null,
      snapshot_received_at: null,
      location_sharing_enabled: false,
      location: null,
      location_received_at: null,
      configurations: [copy(configuration)],
      proposals: [],
      turns: [],
      lines: [],
      members: [],
      invites: [],
      messages: [],
    };
    this.devices.set(device.device_id, record);
    return { ok: true, device: publicDevice(record), configuration: copy(configuration) };
  }

  async deviceByCredential(credentialHash: string) {
    const found = [...this.devices.values()].find((d) => d.credential_hash === credentialHash);
    return found && publicDevice(found);
  }

  async deviceForOwner(deviceId: string, ownerHash: string) {
    const found = this.devices.get(deviceId);
    return found && found.owner_hash === ownerHash ? publicDevice(found) : undefined;
  }

  async devicesForOwner(ownerHash: string) {
    return [...this.devices.values()]
      .filter((d) => d.owner_hash === ownerHash)
      .sort((a, b) => ms(a.created_at) - ms(b.created_at))
      .map(publicDevice);
  }

  async recordHeartbeat(deviceId: string, heartbeat: Heartbeat) {
    const d = this.device(deviceId);
    d.last_heartbeat_at = heartbeat.at;
    d.service_version = heartbeat.service_version;
    d.manifest = copy(heartbeat.manifest);
    d.snapshot = copy(heartbeat.snapshot);
    d.snapshot_received_at = heartbeat.snapshot ? heartbeat.at : null;
    if (d.location_sharing_enabled && heartbeat.location && !heartbeat.manifest.simulator) {
      d.location = { latitude: heartbeat.location.latitude, longitude: heartbeat.location.longitude };
      d.location_received_at = new Date(Date.parse(heartbeat.at) - heartbeat.location.age_ms).toISOString();
    }
    for (const line of heartbeat.events) if (!d.lines.some((l) => l.event_id === line.event_id)) d.lines.push({ ...line });
  }

  async setLocationSharing(deviceId: string, memberId: string, enabled: boolean) {
    const d = this.device(deviceId);
    if (!d.members.some((m) => m.member_id === memberId && m.role === "walker_user" && m.state === "member")) return false;
    return this.writeLocationSharing(deviceId, enabled);
  }

  async writeLocationSharing(deviceId: string, enabled: boolean) {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    d.location_sharing_enabled = enabled;
    // A new opt-in must wait for a new fix; revocation erases the previous one immediately.
    d.location = null;
    d.location_received_at = null;
    return true;
  }

  async currentConfiguration(deviceId: string) {
    return copy(this.current(this.device(deviceId)));
  }

  async expireProposals(deviceId: string, now: Date) {
    const d = this.devices.get(deviceId);
    if (!d) return;
    for (const p of d.proposals) if (shouldExpire(p, d.last_heartbeat_at, now)) p.state = "expired";
  }

  async openProposal(deviceId: string) {
    const found = this.devices.get(deviceId)?.proposals.find((p) => p.state === "open");
    return found && copy(found);
  }

  async recentTurns(deviceId: string, limit: number) {
    const turns = [...(this.devices.get(deviceId)?.turns ?? [])].sort((a, b) => ms(a.turn.created_at) - ms(b.turn.created_at));
    return turns.slice(-limit).map((t) => copy(t.turn));
  }

  async recentLines(deviceId: string, limit: number) {
    const lines = [...(this.devices.get(deviceId)?.lines ?? [])].sort((a, b) => ms(a.at) - ms(b.at));
    return lines.slice(-limit).map(copy);
  }

  async answerProposal(deviceId: string, proposalId: string, answer: Answer, now: Date): Promise<AnswerResult> {
    const d = this.devices.get(deviceId);
    const index = d?.proposals.findIndex((p) => p.proposal_id === proposalId) ?? -1;
    if (!d || index < 0) return { outcome: "not_found" };
    const decision = decideAnswer(d.proposals[index]!, answer, this.current(d), d.last_heartbeat_at, now);
    d.proposals[index] = decision.proposal;
    if (decision.configuration) d.configurations.push(decision.configuration);
    return { outcome: decision.answered ? "answered" : "closed", proposal: copy(decision.proposal) };
  }

  async findTurn(deviceId: string, clientTurnId: string) {
    const d = this.devices.get(deviceId);
    return d && this.storedTurn(d, clientTurnId);
  }

  async saveTurn(deviceId: string, turn: WalkerTurnView, proposal: ProposalView | null, now: Date): Promise<SavedTurn | null> {
    const d = this.devices.get(deviceId);
    if (!d) return null;
    // Synchronous from here on, so two saves of one turn can't both get past this check.
    const prior = this.storedTurn(d, turn.client_turn_id);
    if (prior) return { ...prior, created: false };
    if (proposal) {
      for (const p of d.proposals) if (shouldExpire(p, d.last_heartbeat_at, now)) p.state = "expired";
      for (const p of d.proposals) if (p.state === "open") p.state = "superseded";
      d.proposals.push(copy(proposal));
    }
    d.turns.push({ turn: copy(turn), proposal_id: proposal?.proposal_id ?? null });
    return { turn: copy(turn), proposal: proposal && copy(proposal), created: true };
  }

  async sweep(now: Date, historySince: Date, triesSince: Date) {
    const cutoff = historySince.getTime();
    for (const d of this.devices.values()) {
      if (d.location_received_at && ms(d.location_received_at) < now.getTime() - LOCATION_FIX_MAX_AGE_MS) {
        d.location = null;
        d.location_received_at = null;
      }
      d.turns = d.turns.filter((t) => ms(t.turn.created_at) >= cutoff);
      d.lines = d.lines.filter((l) => ms(l.at) >= cutoff);
      d.proposals = d.proposals.filter((p) => p.state === "open" || ms(p.created_at) >= cutoff);
    }
    for (const [digits, c] of this.codes) if (ms(c.expires_at) <= now.getTime()) this.codes.delete(digits);
    const kept = this.wrongTries.filter((t) => ms(t.at) > triesSince.getTime());
    this.wrongTries.splice(0, this.wrongTries.length, ...kept);
  }

  async forget(deviceId: string, ownerHash: string) {
    const d = this.devices.get(deviceId);
    if (!d || d.owner_hash !== ownerHash) return false;
    return this.devices.delete(deviceId);
  }

  // ---- The two-phone circle. Each method is synchronous after its first line, so each is one step. ----

  async putInvite(invite: CircleInviteRecord, { maxOpen, maxMembers }: { maxOpen: number; maxMembers: number }, now: Date): Promise<PutInviteResult> {
    const d = this.device(invite.device_id);
    d.invites = d.invites.filter((i) => ms(i.expires_at) > now.getTime());
    if (invite.role === "walker_user") {
      if (d.members.some((m) => m.role === "walker_user")) return "walker_user_taken";
      d.invites = d.invites.filter((i) => i.role !== "walker_user");
    }
    if (d.invites.length >= maxOpen || d.members.filter((m) => counts(m, now)).length >= maxMembers) return "circle_full";
    const live = (i: CircleInviteRecord) => i.code === invite.code && ms(i.expires_at) > now.getTime();
    if ([...this.devices.values()].some((other) => other.invites.some(live))) return "code_taken";
    d.invites.push({ ...invite });
    return "ok";
  }

  async circleOf(deviceId: string, now: Date) {
    const d = this.devices.get(deviceId);
    if (!d) return { members: [], invites: [] };
    return {
      members: d.members.map(publicMember),
      invites: d.invites.filter((i) => ms(i.expires_at) > now.getTime()).map((i) => ({ ...i })),
    };
  }

  async claimInvite({ code, now, member, waitingUntil, maxMembers, address_key, triesSince, maxWrong }: InviteClaim): Promise<InviteClaimResult> {
    const wrong = this.wrongTries.filter((t) => t.address_key === address_key && ms(t.at) > triesSince.getTime()).length;
    if (wrong >= maxWrong) return { ok: false, reason: "locked" };
    const d = [...this.devices.values()].find((x) => x.invites.some((i) => i.code === code && ms(i.expires_at) > now.getTime()));
    const invite = d?.invites.find((i) => i.code === code);
    if (!d || !invite) {
      this.wrongTries.push({ address_key, at: now.toISOString() });
      return { ok: false, reason: "code_invalid" };
    }
    if (d.members.filter((m) => counts(m, now)).length >= maxMembers) return { ok: false, reason: "circle_full" };
    if (invite.role === "walker_user" && d.members.some((m) => m.role === "walker_user")) return { ok: false, reason: "walker_user_taken" };
    d.invites = d.invites.filter((i) => i !== invite);
    const waiting = invite.role === "caregiver";
    const record: MemoryMember = {
      ...member,
      device_id: d.device_id,
      name: invite.name,
      role: invite.role,
      state: waiting ? ("waiting" as const) : ("member" as const),
      expires_at: waiting ? waitingUntil : null,
      joined_at: waiting ? null : member.created_at,
    };
    d.members.push(record);
    return { ok: true, member: publicMember(record) };
  }

  async memberBySecret(secretHash: string) {
    for (const d of this.devices.values()) {
      const found = d.members.find((m) => m.secret_hash === secretHash);
      if (found) return publicMember(found);
    }
    return undefined;
  }

  async circleDevice(deviceId: string) {
    const found = this.devices.get(deviceId);
    return found && publicDevice(found);
  }

  async approveJoin(deviceId: string, memberId: string, now: Date) {
    const m = this.devices.get(deviceId)?.members.find((x) => x.member_id === memberId);
    if (m?.state === "member") return publicMember(m);
    if (!m || !counts(m, now)) return undefined;
    m.state = "member";
    m.expires_at = null;
    m.joined_at = now.toISOString();
    if (m.replaces_member_id) this.dropMember(m.replaces_member_id);
    return publicMember(m);
  }

  async removeMember(deviceId: string, memberId: string) {
    const d = this.devices.get(deviceId);
    if (!d || !d.members.some((m) => m.member_id === memberId)) return false;
    this.dropMember(memberId);
    return true;
  }

  async saveMessage(message: CircleMessageRecord, maxLive: number, now: Date) {
    const d = this.devices.get(message.device_id);
    if (!d) return null;
    const prior = d.messages.find((m) => m.from_member_id === message.from_member_id && m.client_message_id === message.client_message_id);
    if (prior?.cleared) return "cleared" as const;
    if (prior) return { message: publicMessage(prior), created: false };
    const isMember = (id: string) => d.members.some((m) => m.member_id === id && m.state === "member");
    if (!isMember(message.from_member_id) || !isMember(message.to_member_id)) return null;
    d.messages = d.messages.filter((m) => ms(m.expires_at) > now.getTime());
    d.messages.push({ ...message, cleared: false });
    const live = d.messages.filter((m) => !m.cleared);
    for (const old of live.slice(0, Math.max(0, live.length - maxLive))) {
      old.cleared = true;
      old.text = "";
    }
    return { message: { ...message }, created: true };
  }

  async messagesFor(deviceId: string, memberId: string, now: Date) {
    const d = this.devices.get(deviceId);
    return (d?.messages ?? [])
      .filter((m) => !m.cleared && ms(m.expires_at) > now.getTime() && (m.from_member_id === memberId || m.to_member_id === memberId))
      .map(publicMessage);
  }

  /** Removes a member wherever it is, with every message to or from it. */
  private dropMember(memberId: string) {
    for (const d of this.devices.values()) {
      if (d.members.some((m) => m.member_id === memberId && m.role === "walker_user")) {
        d.location_sharing_enabled = false;
        d.location = null;
        d.location_received_at = null;
      }
      d.members = d.members.filter((m) => m.member_id !== memberId);
      d.messages = d.messages.filter((m) => m.from_member_id !== memberId && m.to_member_id !== memberId);
    }
  }

  async sweepCircle(now: Date, lapsedBefore: Date) {
    for (const d of this.devices.values()) {
      if (d.location_received_at && ms(d.location_received_at) < now.getTime() - LOCATION_FIX_MAX_AGE_MS) {
        d.location = null;
        d.location_received_at = null;
      }
      d.invites = d.invites.filter((i) => ms(i.expires_at) > now.getTime());
      d.messages = d.messages.filter((m) => ms(m.expires_at) > now.getTime());
      d.members = d.members.filter((m) => m.state === "member" || m.expires_at === null || ms(m.expires_at) >= lapsedBefore.getTime());
    }
  }

  private device(deviceId: string): MemoryDevice {
    const d = this.devices.get(deviceId);
    if (!d) throw new Error("No such walker.");
    return d;
  }

  private storedTurn(d: MemoryDevice, clientTurnId: string) {
    const found = d.turns.find((t) => t.turn.client_turn_id === clientTurnId);
    if (!found) return undefined;
    const opened = d.proposals.find((p) => p.proposal_id === found.proposal_id);
    return { turn: copy(found.turn), proposal: opened ? copy(opened) : null };
  }

  private current(d: MemoryDevice): WalkerConfiguration {
    return d.configurations.reduce((a, b) => (b.version > a.version ? b : a));
  }
}

function publicDevice(d: MemoryDevice): DeviceRecord {
  return {
    device_id: d.device_id,
    owner_hash: d.owner_hash,
    name: d.name,
    service_version: d.service_version,
    created_at: d.created_at,
    last_heartbeat_at: d.last_heartbeat_at,
    manifest: copy(d.manifest),
    snapshot: copy(d.snapshot),
    snapshot_received_at: d.snapshot_received_at,
    location_sharing_enabled: d.location_sharing_enabled,
    location: copy(d.location),
    location_received_at: d.location_received_at,
  };
}
