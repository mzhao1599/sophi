import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { TurnResponse } from "@walker/contracts";
import { storedState, type EngineSession } from "./engine";
import { StoreFullError, type SaveExtras, type SessionOwner, type SessionStore, type StoredSession } from "./store";

/**
 * Onboarding sessions in Supabase Postgres (tables and policies: supabase/migrations/).
 *
 * Two clients, two kinds of session:
 * - Account sessions go through `user`, a client carrying the signed-in user's own access token,
 *   so row-level security decides which rows exist for this request.
 * - Demo sessions have no account, so they go through `admin` (the secret, service-role key, which
 *   bypasses RLS). Every admin query names the session's token hash and `user_id is null`, so the
 *   admin client never reads or writes an account's row. The secret key stays on the server.
 *
 * Build one store per request: `user` belongs to whoever made that request.
 */
export interface SupabaseStoreClients {
  admin: SupabaseClient;
  user: SupabaseClient | null;
}

const SESSIONS = "onboarding_sessions";
const RESULTS = "onboarding_turn_results";
const CONFIGURATIONS = "device_configurations";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupabaseStoreOptions {
  /**
   * Live (unexpired) demo sessions allowed at once; past it, starting a demo is refused until some
   * expire. Anyone can start one, so this bounds what strangers can store. Default 500.
   */
  maxLiveDemoSessions?: number;
}

interface SessionRow {
  id: string;
  user_id: string | null;
  demo_token_hash: string | null;
  expires_at: string;
  engine_state: EngineSession;
}

export class SupabaseStoreError extends Error {
  override readonly name = "SupabaseStoreError";
  constructor(
    action: string,
    readonly code: string | undefined,
  ) {
    // The database's own message can quote row data, so only the action and the code are kept.
    super(`Couldn't ${action} (database error ${code ?? "unknown"}).`);
  }
}

function fail(action: string, error: PostgrestError): never {
  throw new SupabaseStoreError(action, error.code);
}

export class SupabaseSessionStore implements SessionStore {
  private readonly maxLiveDemoSessions: number;

  constructor(
    private readonly clients: SupabaseStoreClients,
    options: SupabaseStoreOptions = {},
  ) {
    this.maxLiveDemoSessions = options.maxLiveDemoSessions ?? 500;
  }

  async get(id: string, owner: SessionOwner): Promise<StoredSession | undefined> {
    if (!UUID.test(id)) return undefined;
    const columns = "id, user_id, demo_token_hash, expires_at, engine_state";
    const query =
      owner.kind === "demo"
        ? this.clients.admin.from(SESSIONS).select(columns).eq("id", id).is("user_id", null).eq("demo_token_hash", owner.token_hash)
        : this.user(owner).from(SESSIONS).select(columns).eq("id", id).eq("user_id", owner.user_id);
    const { data, error } = await query.maybeSingle<SessionRow>();
    if (error) fail("read a session", error);
    if (!data || data.engine_state?.id !== data.id) return undefined;
    // The owner as the row records it, so the service's own ownership check compares real data.
    const stored: SessionOwner = data.user_id
      ? { kind: "account", user_id: data.user_id }
      : { kind: "demo", token_hash: data.demo_token_hash ?? "" };
    // The column's expiry is the one the database bounds and the expiry job uses, so it is the one that counts.
    return { session: { ...data.engine_state, expires_at: new Date(data.expires_at).toISOString() }, owner: stored };
  }

  async getResponse(id: string, owner: SessionOwner, clientTurnId: string): Promise<TurnResponse | undefined> {
    if (!UUID.test(id) || !UUID.test(clientTurnId)) return undefined;
    const query =
      owner.kind === "demo"
        ? this.clients.admin
            .from(RESULTS)
            .select("response, onboarding_sessions!inner(id)")
            .eq("session_id", id)
            .eq("client_turn_id", clientTurnId)
            .is("onboarding_sessions.user_id", null)
            .eq("onboarding_sessions.demo_token_hash", owner.token_hash)
        : this.user(owner).from(RESULTS).select("response").eq("session_id", id).eq("client_turn_id", clientTurnId);
    const { data, error } = await query.maybeSingle<{ response: TurnResponse }>();
    if (error) fail("read a turn result", error);
    return data?.response;
  }

  async create(record: StoredSession): Promise<void> {
    const { session, owner } = record;
    if (owner.kind === "demo") {
      const { count, error } = await this.clients.admin
        .from(SESSIONS)
        .select("id", { count: "exact", head: true })
        .is("user_id", null)
        .gt("expires_at", new Date().toISOString());
      if (error) fail("count demo sessions", error);
      if ((count ?? 0) >= this.maxLiveDemoSessions) throw new StoreFullError();
    }
    const { error } = await this.client(owner)
      .from(SESSIONS)
      .insert({
        id: session.id,
        user_id: owner.kind === "account" ? owner.user_id : null,
        demo_token_hash: owner.kind === "demo" ? owner.token_hash : null,
        state: storedState(session),
        revision: session.revision,
        catalog_version: session.catalog_version,
        engine_state: session,
        expires_at: session.expires_at,
        created_at: session.created_at,
      });
    if (error) fail("start a session", error);
  }

  async save(record: StoredSession, expectedRevision: number, extras: SaveExtras = {}): Promise<boolean> {
    const { session, owner } = record;
    const { data, error } = await this.client(owner).rpc("save_onboarding_session", {
      p_id: session.id,
      p_expected_revision: expectedRevision,
      p_revision: session.revision,
      p_state: storedState(session),
      p_engine_state: session,
      p_expires_at: session.expires_at,
      p_demo_token_hash: owner.kind === "demo" ? owner.token_hash : null,
      p_client_turn_id: extras.turn?.client_turn_id ?? null,
      p_response: extras.turn?.response ?? null,
      p_configuration: extras.configuration ?? null,
    });
    if (error) fail("save a session", error);
    return data === true;
  }

  async delete(id: string, owner: SessionOwner): Promise<void> {
    if (!UUID.test(id)) return;
    const query =
      owner.kind === "demo"
        ? this.clients.admin.from(SESSIONS).delete().eq("id", id).is("user_id", null).eq("demo_token_hash", owner.token_hash)
        : this.user(owner).from(SESSIONS).delete().eq("id", id).eq("user_id", owner.user_id);
    const { error } = await query;
    if (error) fail("delete a session", error);
  }

  async nextConfigurationVersion(owner: SessionOwner): Promise<number> {
    if (owner.kind === "demo") return 1;
    const { data, error } = await this.user(owner)
      .from(CONFIGURATIONS)
      .select("configuration_version")
      .eq("user_id", owner.user_id)
      .order("configuration_version", { ascending: false })
      .limit(1)
      .maybeSingle<{ configuration_version: number }>();
    if (error) fail("number a setup", error);
    return (data?.configuration_version ?? 0) + 1;
  }

  private client(owner: SessionOwner): SupabaseClient {
    return owner.kind === "demo" ? this.clients.admin : this.user(owner);
  }

  private user(_owner: SessionOwner): SupabaseClient {
    if (!this.clients.user) throw new Error("An account session needs the signed-in user's Supabase client.");
    return this.clients.user;
  }
}
