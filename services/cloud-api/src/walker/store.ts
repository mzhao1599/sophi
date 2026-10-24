import { createHash, randomBytes } from "node:crypto";
import type {
  CapabilityManifest,
  ProposalView,
  SensorSnapshot,
  WalkerConfiguration,
  WalkerEventView,
  WalkerTurnView,
} from "@walker/contracts";
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

export interface WalkerStore {
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
  currentConfiguration(deviceId: string): Promise<WalkerConfiguration>;
  /** Marks the open proposal expired if it is past its expiry or the walker is offline at `now`. */
  expireProposals(deviceId: string, now: Date): Promise<void>;
  openProposal(deviceId: string): Promise<ProposalView | undefined>;
  /** The newest `limit`, oldest first. */
  recentTurns(deviceId: string, limit: number): Promise<WalkerTurnView[]>;
  recentLines(deviceId: string, limit: number): Promise<WalkerEventView[]>;

  /** Answers one proposal by id in one atomic step (rules.ts decides): the first answer wins. */
  answerProposal(deviceId: string, proposalId: string, answer: Answer, now: Date): Promise<AnswerResult>;
  /**
   * Stores a turn and, when it opened one, its proposal, in one step: an open proposal that has expired
   * by `now` is marked expired, and one still open is superseded. A client_turn_id already stored
   * returns that turn and its proposal instead, so a retry never opens a second.
   */
  saveTurn(deviceId: string, turn: WalkerTurnView, proposal: ProposalView | null, now: Date): Promise<SavedTurn>;

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
      configurations: [copy(configuration)],
      proposals: [],
      turns: [],
      lines: [],
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
    for (const line of heartbeat.events) if (!d.lines.some((l) => l.event_id === line.event_id)) d.lines.push({ ...line });
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

  async saveTurn(deviceId: string, turn: WalkerTurnView, proposal: ProposalView | null, now: Date): Promise<SavedTurn> {
    const d = this.device(deviceId);
    const prior = d.turns.find((t) => t.turn.client_turn_id === turn.client_turn_id);
    if (prior) {
      const opened = d.proposals.find((p) => p.proposal_id === prior.proposal_id);
      return { turn: copy(prior.turn), proposal: opened ? copy(opened) : null, created: false };
    }
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

  private device(deviceId: string): MemoryDevice {
    const d = this.devices.get(deviceId);
    if (!d) throw new Error("No such walker.");
    return d;
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
  };
}
