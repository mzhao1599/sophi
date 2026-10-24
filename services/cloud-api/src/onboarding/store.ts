import { createHash, timingSafeEqual } from "node:crypto";
import type { DeviceConfiguration, TurnResponse } from "@walker/contracts";
import type { EngineSession } from "./engine";

/**
 * Where onboarding sessions live. Two implementations: MemorySessionStore (below) for local demos
 * and tests, and SupabaseSessionStore (supabase-store.ts) for Postgres with row-level security.
 */

/**
 * Who owns a session. A demo session belongs to whoever holds its secret token, and stores keep
 * only the token's hash. An account session belongs to a signed-in user.
 */
export type SessionOwner = { kind: "demo"; token_hash: string } | { kind: "account"; user_id: string };

export interface StoredSession {
  session: EngineSession;
  owner: SessionOwner;
}

/** Written in the same atomic save as the session. */
export interface SaveExtras {
  /** The response a turn got, so a retry with the same client_turn_id returns it. */
  turn?: { client_turn_id: string; response: TurnResponse };
  /** An account session's confirmed configuration, stored as one of the owner's setups. */
  configuration?: DeviceConfiguration;
}

/** A store refuses a new session when it holds as many as it may (a cap on anonymous demo sessions). */
export class StoreFullError extends Error {
  override readonly name = "StoreFullError";
  constructor() {
    super("The session store is full.");
  }
}

export interface SessionStore {
  /** The session, if it exists and `owner` owns it. Unknown id and wrong owner look the same. */
  get(id: string, owner: SessionOwner): Promise<StoredSession | undefined>;
  /** The response an earlier turn with this client_turn_id got, if `owner` owns the session. */
  getResponse(id: string, owner: SessionOwner, clientTurnId: string): Promise<TurnResponse | undefined>;
  /** Throws StoreFullError when the store won't take another session of this kind now. */
  create(record: StoredSession): Promise<void>;
  /**
   * Saves the session only if its stored revision is still `expectedRevision`, with `extras` in the
   * same step. Returns false, having saved nothing, when another request got there first.
   */
  save(record: StoredSession, expectedRevision: number, extras?: SaveExtras): Promise<boolean>;
  delete(id: string, owner: SessionOwner): Promise<void>;
  /** The configuration_version the owner's next confirmed setup gets: 1, 2, 3… per account; always 1 for a demo. */
  nextConfigurationVersion(owner: SessionOwner): Promise<number>;
}

/** SHA-256 of a demo session's secret, as hex. The token has 244 random bits, so no salt is needed. */
export function hashDemoToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sameOwner(a: SessionOwner, b: SessionOwner): boolean {
  if (a.kind === "account") return b.kind === "account" && a.user_id === b.user_id;
  if (b.kind === "account") return false;
  const x = Buffer.from(a.token_hash);
  const y = Buffer.from(b.token_hash);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Only the latest turns are ever retried; the database keeps the same number (save_onboarding_session). */
export const MAX_REMEMBERED_RESPONSES = 5;

/**
 * In-memory store. Data is lost when the server restarts, and on a multi-instance host (such as
 * Vercel) two requests may reach different instances, so this is for local demos and tests only;
 * production refuses it unless ONBOARDING_ALLOW_MEMORY_STORE=true (see storeBackendFromEnv).
 */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, StoredSession>();
  private readonly responses = new Map<string, Map<string, TurnResponse>>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maxSessions = 500,
  ) {}

  async get(id: string, owner: SessionOwner) {
    this.sweep();
    const record = this.records.get(id);
    return record && sameOwner(record.owner, owner) ? record : undefined;
  }

  async getResponse(id: string, owner: SessionOwner, clientTurnId: string) {
    return (await this.get(id, owner)) ? this.responses.get(id)?.get(clientTurnId) : undefined;
  }

  async create(record: StoredSession) {
    if (this.records.has(record.session.id)) throw new Error("A session with this id already exists.");
    this.records.set(record.session.id, record);
    this.sweep();
  }

  async save(record: StoredSession, expectedRevision: number, extras: SaveExtras = {}) {
    const id = record.session.id;
    const current = this.records.get(id);
    if (!current || !sameOwner(current.owner, record.owner) || current.session.revision !== expectedRevision) return false;
    const version = extras.configuration?.configuration_version;
    if (version !== undefined && this.versions(record.owner).includes(version)) return false;
    this.records.set(id, record);
    if (extras.turn) {
      const responses = this.responses.get(id) ?? new Map<string, TurnResponse>();
      responses.set(extras.turn.client_turn_id, extras.turn.response);
      if (responses.size > MAX_REMEMBERED_RESPONSES) {
        const oldest = responses.keys().next().value;
        if (oldest !== undefined) responses.delete(oldest);
      }
      this.responses.set(id, responses);
    }
    return true;
  }

  async delete(id: string, owner: SessionOwner) {
    if (!(await this.get(id, owner))) return;
    this.records.delete(id);
    this.responses.delete(id);
  }

  async nextConfigurationVersion(owner: SessionOwner) {
    return owner.kind === "demo" ? 1 : Math.max(0, ...this.versions(owner)) + 1;
  }

  private versions(owner: SessionOwner): number[] {
    if (owner.kind === "demo") return [];
    return [...this.records.values()].flatMap((r) =>
      r.owner.kind === "account" && r.owner.user_id === owner.user_id && r.session.configuration ? [r.session.configuration.configuration_version] : [],
    );
  }

  /**
   * Deletes expired sessions, except confirmed account sessions (kept with their setup until the
   * user deletes them): the same expiry rule as the database. Then, unlike the database, which
   * refuses new demo sessions past its cap, it drops the oldest sessions of any kind past this one.
   */
  private sweep() {
    const now = this.now().getTime();
    for (const [id, r] of this.records) {
      const keep = r.owner.kind === "account" && r.session.configuration !== null;
      if (!keep && Date.parse(r.session.expires_at) < now) this.drop(id);
    }
    while (this.records.size > this.maxSessions) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  private drop(id: string) {
    this.records.delete(id);
    this.responses.delete(id);
  }
}
