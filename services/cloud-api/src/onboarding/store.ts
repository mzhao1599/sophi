import type { TurnResponse } from "@walker/contracts";
import type { EngineSession } from "./engine";

/**
 * Where onboarding sessions live. The demo uses server memory; the Supabase-backed store will
 * implement the same interface (with row-level security on user-owned rows) when accounts land.
 */
export interface StoredSession {
  session: EngineSession;
  /** Proves the caller started this session: kept in an httpOnly cookie, never in a URL or log. */
  token: string;
  /** Prior responses by client_turn_id, so a retried request returns the same result. */
  responses: Map<string, TurnResponse>;
}

export interface SessionStore {
  get(id: string): Promise<StoredSession | undefined>;
  put(record: StoredSession): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * In-memory store for demo sessions. Data is lost when the server restarts, and on a multi-instance
 * host (such as Vercel) two requests may reach different instances, so this is for local demos only.
 */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, StoredSession>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maxSessions = 500,
  ) {}

  async get(id: string) {
    this.sweep();
    return this.records.get(id);
  }

  async put(record: StoredSession) {
    this.records.set(record.session.id, record);
    this.sweep();
  }

  async delete(id: string) {
    this.records.delete(id);
  }

  /** Deletes expired sessions, then the oldest ones if the cap is reached. */
  private sweep() {
    const now = this.now().getTime();
    for (const [id, r] of this.records) if (Date.parse(r.session.expires_at) < now) this.records.delete(id);
    while (this.records.size > this.maxSessions) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }
}
