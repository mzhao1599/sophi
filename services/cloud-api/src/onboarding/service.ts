import {
  MODULE_CATALOG,
  checkSelection,
  type ApiErrorCode,
  type ConfirmRequest,
  type ProfileEditRequest,
  type SessionResponse,
  type SessionView,
  type StartSessionRequest,
  type TurnRequest,
  type TurnResponse,
} from "@walker/contracts";
import { EngineError, confirm, createSession, deterministicEngine, editFact, toView, type EngineSession, type TurnEngine } from "./engine";
import { StoreFullError, hashDemoToken, sameOwner, type SessionOwner, type SessionStore, type StoredSession } from "./store";

export class OnboardingError extends Error {
  override readonly name = "OnboardingError";
  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly session?: SessionView,
  ) {
    super(message);
  }
}

/**
 * Recognises an OnboardingError by its shape as well as its class: a dev server's hot reload can
 * leave a service instance from an older copy of this module, whose errors fail `instanceof`.
 */
export function isOnboardingError(error: unknown): error is OnboardingError {
  return (
    error instanceof OnboardingError ||
    (error instanceof Error && error.name === "OnboardingError" && "code" in error && "status" in error)
  );
}

/**
 * Who is calling. The web layer fills this in: `token` from the demo cookie for this session id,
 * `user_id` from a verified Supabase Auth session. Either, both or neither may be set.
 */
export interface Caller {
  token?: string;
  user_id?: string;
}

export interface OnboardingServiceOptions {
  now?: () => Date;
  /** Demo sessions expire this long after the last change. */
  ttlMs?: number;
  /** Unfinished account sessions expire this long after the last change. */
  accountTtlMs?: number;
  randomId?: () => string;
  /** How text and answer turns are read. Defaults to the deterministic engine. */
  engine?: TurnEngine;
  /** Set when this server must not start sessions (see storeBackendFromEnv): start() answers 503 with this message. */
  startBlocked?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A real setup takes 20 to 40 turns. The cap bounds how large one session can grow. */
export const MAX_TURNS_PER_SESSION = 200;

/**
 * The onboarding API's behaviour, independent of HTTP: ownership, expiry, revision checks and
 * idempotent turns. Route handlers parse requests with the contract schemas, call this, and map
 * OnboardingError to the error envelope.
 */
export class OnboardingService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly accountTtlMs: number;
  private readonly randomId: () => string;
  private readonly startBlocked: string | undefined;
  readonly engine: TurnEngine;

  constructor(
    private readonly store: SessionStore,
    options: OnboardingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.accountTtlMs = options.accountTtlMs ?? 30 * DAY_MS;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.engine = options.engine ?? deterministicEngine;
    this.startBlocked = options.startBlocked;
  }

  /**
   * Starts a session of the kind the user's consent names: a demo session (the returned `token` goes
   * in the caller's cookie) or, for a signed-in caller, an account session (no token).
   */
  async start(request: StartSessionRequest, caller: Caller = {}): Promise<{ token?: string; response: TurnResponse }> {
    if (this.startBlocked) throw new OnboardingError("unavailable", 503, this.startBlocked);
    const account = "account_data_notice" in request.consent;
    if (account && !caller.user_id) {
      throw new OnboardingError("unauthenticated", 401, "Sign in to save your setup to your account, or start the demo instead.");
    }
    const now = this.now();
    const kind = account ? "account" : "demo";
    const session = createSession(this.randomId(), now, this.ttlFor(kind), kind);
    const token = account ? undefined : `${this.randomId()}${this.randomId()}`.replaceAll("-", "");
    const owner: SessionOwner = token ? { kind: "demo", token_hash: hashDemoToken(token) } : { kind: "account", user_id: caller.user_id! };
    try {
      await this.store.create({ session, owner });
    } catch (error) {
      if (!(error instanceof StoreFullError)) throw error;
      throw new OnboardingError("unavailable", 503, "A lot of people are trying the demo right now. Please try again in a few minutes.");
    }
    const view = toView(session, now);
    const assistant_text = session.turns.map((t) => t.text).join(" ");
    return { token, response: { session: view, assistant_text, ack: null, needs_user_confirmation: false } };
  }

  async get(id: string, caller: Caller): Promise<SessionResponse> {
    const record = await this.load(id, caller, { allowExpired: true });
    return { session: toView(record.session, this.now()) };
  }

  async turn(id: string, caller: Caller, request: TurnRequest): Promise<TurnResponse> {
    const record = await this.load(id, caller);
    const prior = await this.store.getResponse(id, record.owner, request.client_turn_id);
    if (prior) return prior;
    this.checkRevision(record, request.last_seen_revision);
    // "Skip the rest" stays open, so a capped conversation can still reach review and be saved.
    if (record.session.turns.length >= MAX_TURNS_PER_SESSION && request.input.type !== "skip_rest") {
      throw new OnboardingError("invalid_request", 422, "This conversation has got very long. Review and save what you have, or start a new setup.");
    }

    const now = this.now();
    // An agent turn takes seconds. The save below only lands if nothing else changed the session meanwhile.
    const result = await this.run(record, () => this.engine.apply(record.session, request.input, now));
    const session = this.bump(result.session, now);
    const view = toView(session, now);
    const response: TurnResponse = {
      session: view,
      assistant_text: result.assistant_text,
      ack: result.ack,
      needs_user_confirmation: view.state === "review",
    };
    const saved = await this.store.save({ ...record, session }, record.session.revision, {
      turn: { client_turn_id: request.client_turn_id, response },
    });
    if (saved) return response;
    // Another request saved first. If it was a retry of this same turn, its response is the answer.
    const done = await this.store.getResponse(id, record.owner, request.client_turn_id);
    if (done) return done;
    return this.conflict(id, record.owner);
  }

  async editProfile(id: string, caller: Caller, request: ProfileEditRequest): Promise<SessionResponse> {
    const record = await this.load(id, caller);
    this.checkRevision(record, request.last_seen_revision);
    const now = this.now();
    const session = this.bump(await this.run(record, () => editFact(record.session, request.edit)), now);
    if (!(await this.store.save({ ...record, session }, record.session.revision))) await this.conflict(id, record.owner);
    return { session: toView(session, now) };
  }

  async confirm(id: string, caller: Caller, request: ConfirmRequest): Promise<SessionResponse> {
    const record = await this.load(id, caller);
    this.checkRevision(record, request.last_seen_revision);
    const now = this.now();
    const view = toView(record.session, now);
    if (view.state === "collecting") {
      throw new OnboardingError("invalid_request", 409, "Finish or skip the remaining questions before saving.", view);
    }
    const problems = checkSelection(MODULE_CATALOG, request.selected_module_ids);
    if (problems.length > 0) {
      throw new OnboardingError("invalid_selection", 422, problems.map((p) => p.message).join(" "));
    }
    const version = await this.store.nextConfigurationVersion(record.owner);
    const session = this.bump(await this.run(record, () => confirm(record.session, request.selected_module_ids, now, version)), now);
    const configuration = record.owner.kind === "account" ? session.configuration ?? undefined : undefined;
    // A false save here can also mean another of the owner's setups took this number at the same moment.
    if (!(await this.store.save({ ...record, session }, record.session.revision, { configuration }))) await this.conflict(id, record.owner);
    return { session: toView(session, now) };
  }

  /** Deletes the session now, and for an account session the setup confirmed in it. */
  async remove(id: string, caller: Caller): Promise<void> {
    const record = await this.load(id, caller, { allowExpired: true });
    await this.store.delete(id, record.owner);
  }

  // ---- helpers ----

  private ttlFor(kind: EngineSession["kind"]): number {
    return kind === "account" ? this.accountTtlMs : this.ttlMs;
  }

  private async load(id: string, caller: Caller, opts: { allowExpired?: boolean } = {}): Promise<StoredSession> {
    // A demo cookie names one session id, so try it first; then the signed-in user's own sessions.
    const owners: SessionOwner[] = [];
    if (caller.token) owners.push({ kind: "demo", token_hash: hashDemoToken(caller.token) });
    if (caller.user_id) owners.push({ kind: "account", user_id: caller.user_id });
    let record: StoredSession | undefined;
    for (const owner of owners) {
      const found = await this.store.get(id, owner);
      // The store filters by owner; this check keeps that true whatever store is plugged in.
      if (found && sameOwner(found.owner, owner)) {
        record = found;
        break;
      }
    }
    // The same answer for "no such session" and "not yours", so ids can't be probed.
    if (!record) throw new OnboardingError("not_found", 404, "This setup session wasn't found. It may have expired.");
    // A confirmed account setup is kept until its owner deletes it, so it never expires.
    const kept = record.session.kind === "account" && record.session.configuration !== null;
    if (!opts.allowExpired && !kept && this.now().getTime() > Date.parse(record.session.expires_at)) {
      const message =
        record.session.kind === "account"
          ? "This unfinished setup expired after 30 days without changes. Start a new one to continue."
          : "This demo session has expired. Start a new one to continue.";
      throw new OnboardingError("session_expired", 410, message);
    }
    return record;
  }

  /** Another request saved first: a revision conflict carrying the current state. */
  private async conflict(id: string, owner: SessionOwner): Promise<never> {
    const latest = await this.store.get(id, owner);
    if (!latest) throw new OnboardingError("not_found", 404, "This setup session wasn't found. It may have expired.");
    throw conflictError(toView(latest.session, this.now()));
  }

  private checkRevision(record: StoredSession, lastSeen: number) {
    if (lastSeen !== record.session.revision) throw conflictError(toView(record.session, this.now()));
  }

  private async run<T>(record: StoredSession, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof EngineError)) throw error;
      const status = error.code === "not_found" ? 404 : error.code === "invalid_request" ? 400 : error.code === "invalid_selection" ? 422 : 409;
      throw new OnboardingError(error.code, status, error.message, toView(record.session, this.now()));
    }
  }

  private bump(session: EngineSession, now: Date): EngineSession {
    return { ...session, revision: session.revision + 1, expires_at: new Date(now.getTime() + this.ttlFor(session.kind)).toISOString() };
  }
}

function conflictError(view: SessionView): OnboardingError {
  return new OnboardingError("revision_conflict", 409, "This setup changed in another tab or window. The latest version is shown.", view);
}
