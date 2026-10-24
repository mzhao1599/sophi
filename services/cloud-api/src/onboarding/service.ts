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
import type { SessionStore, StoredSession } from "./store";

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

export interface OnboardingServiceOptions {
  now?: () => Date;
  /** Demo sessions expire this long after the last change. */
  ttlMs?: number;
  randomId?: () => string;
  /** How text and answer turns are read. Defaults to the deterministic engine. */
  engine?: TurnEngine;
}

const MAX_REMEMBERED_RESPONSES = 50;

/**
 * The onboarding API's behaviour, independent of HTTP: ownership, expiry, revision checks and
 * idempotent turns. Route handlers parse requests with the contract schemas, call this, and map
 * OnboardingError to the error envelope.
 */
export class OnboardingService {
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly randomId: () => string;
  readonly engine: TurnEngine;

  constructor(
    private readonly store: SessionStore,
    options: OnboardingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? 60 * 60 * 1000;
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.engine = options.engine ?? deterministicEngine;
  }

  async start(_request: StartSessionRequest): Promise<{ token: string; response: TurnResponse }> {
    const now = this.now();
    const session = createSession(this.randomId(), now, this.ttlMs);
    const token = `${this.randomId()}${this.randomId()}`.replaceAll("-", "");
    await this.store.put({ session, token, responses: new Map() });
    const view = toView(session, now);
    const assistant_text = session.turns.map((t) => t.text).join(" ");
    return { token, response: { session: view, assistant_text, ack: null, needs_user_confirmation: false } };
  }

  async get(id: string, token: string | undefined): Promise<SessionResponse> {
    const record = await this.load(id, token, { allowExpired: true });
    return { session: toView(record.session, this.now()) };
  }

  async turn(id: string, token: string | undefined, request: TurnRequest): Promise<TurnResponse> {
    const record = await this.load(id, token);
    const prior = record.responses.get(request.client_turn_id);
    if (prior) return prior;
    this.checkRevision(record, request.last_seen_revision);

    const now = this.now();
    const result = await this.run(record, () => this.engine.apply(record.session, request.input, now));
    // An agent turn takes seconds. If another request changed the session meanwhile, that one stands.
    const latest = await this.load(id, token);
    const done = latest.responses.get(request.client_turn_id);
    if (done) return done;
    this.checkRevision(latest, record.session.revision);
    const session = this.bump(result.session, now);
    const view = toView(session, now);
    const response: TurnResponse = {
      session: view,
      assistant_text: result.assistant_text,
      ack: result.ack,
      needs_user_confirmation: view.state === "review",
    };
    record.responses.set(request.client_turn_id, response);
    if (record.responses.size > MAX_REMEMBERED_RESPONSES) {
      const oldest = record.responses.keys().next().value;
      if (oldest !== undefined) record.responses.delete(oldest);
    }
    await this.store.put({ ...record, session });
    return response;
  }

  async editProfile(id: string, token: string | undefined, request: ProfileEditRequest): Promise<SessionResponse> {
    const record = await this.load(id, token);
    this.checkRevision(record, request.last_seen_revision);
    const now = this.now();
    const session = this.bump(await this.run(record, () => editFact(record.session, request.edit)), now);
    await this.store.put({ ...record, session });
    return { session: toView(session, now) };
  }

  async confirm(id: string, token: string | undefined, request: ConfirmRequest): Promise<SessionResponse> {
    const record = await this.load(id, token);
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
    const session = this.bump(await this.run(record, () => confirm(record.session, request.selected_module_ids, now)), now);
    await this.store.put({ ...record, session });
    return { session: toView(session, now) };
  }

  async remove(id: string, token: string | undefined): Promise<void> {
    await this.load(id, token, { allowExpired: true });
    await this.store.delete(id);
  }

  // ---- helpers ----

  private async load(id: string, token: string | undefined, opts: { allowExpired?: boolean } = {}): Promise<StoredSession> {
    const record = await this.store.get(id);
    // The same answer for "no such session" and "not yours", so ids can't be probed.
    if (!record || !token || !sameSecret(record.token, token)) {
      throw new OnboardingError("not_found", 404, "This setup session wasn't found. It may have expired.");
    }
    if (!opts.allowExpired && this.now().getTime() > Date.parse(record.session.expires_at)) {
      throw new OnboardingError("session_expired", 410, "This demo session has expired. Start a new one to continue.");
    }
    return record;
  }

  private checkRevision(record: StoredSession, lastSeen: number) {
    if (lastSeen !== record.session.revision) {
      throw new OnboardingError(
        "revision_conflict",
        409,
        "This setup changed in another tab or window. The latest version is shown.",
        toView(record.session, this.now()),
      );
    }
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
    return { ...session, revision: session.revision + 1, expires_at: new Date(now.getTime() + this.ttlMs).toISOString() };
  }
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
