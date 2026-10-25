import {
  AnswerProposalResponseSchema,
  PairingCodeResponseSchema,
  SpeechPaceResponseSchema,
  WalkerErrorSchema,
  WalkerListResponseSchema,
  WalkerTurnResponseSchema,
  type AnswerProposalResponse,
  type PairingCodeResponse,
  type ProposalView,
  type SpeechPace,
  type SpeechPaceResponse,
  type WalkerActivityView,
  type WalkerErrorCode,
  type WalkerSpeechPaceView,
  type WalkerStatusView,
  type WalkerTurnResponse,
} from "@walker/contracts";
import type { z } from "zod";

/**
 * What the "Your walker" page asks of the server: the owner's routes in `packages/contracts/src/walker.ts`
 * (`/api/v1/walkers/...`, proven by the `walker_owner` cookie). The page only talks to this interface, so
 * the development fake (`walkerFake.ts`) can stand in for the real fetch below with nothing else changed.
 */
export interface WalkerPageApi {
  /**
   * Every walker this browser owns, and what the server measured of their turns (`activity`: page only,
   * empty when the server sent none). A browser without the owner cookie gets `unauthenticated`.
   */
  listWalkers(signal?: AbortSignal): Promise<WalkerList>;
  /** A one-time pairing code for `walker pair`; sets the owner cookie if the browser has none. */
  createPairingCode(): Promise<PairingCodeResponse>;
  /** A typed question. Reusing `clientTurnId` gets the stored answer back and runs nothing again. */
  sendTurn(deviceId: string, clientTurnId: string, text: string): Promise<WalkerTurnResponse>;
  answerProposal(deviceId: string, proposalId: string, answer: "confirm" | "decline"): Promise<AnswerProposalResponse>;
  /** How fast Sophi talks in Cartesia's voice, in force from its next line, with no Confirm. */
  setSpeechPace(deviceId: string, pace: SpeechPace): Promise<SpeechPaceResponse>;
  /** Deletes the walker, its turns, configurations and proposals, and revokes its credential. */
  forgetWalker(deviceId: string): Promise<void>;
  /** The server's clock minus this browser's, in milliseconds: 0 until a response says otherwise. */
  clockOffsetMs(): number;
}

/** The list response as the page uses it: `activity` and `speech_paces` are optional in the contract, so they default to none. */
export interface WalkerList {
  walkers: WalkerStatusView[];
  activity: WalkerActivityView[];
  speech_paces: WalkerSpeechPaceView[];
}

/**
 * Why a request failed: one of the contract's codes, `network` when no answer arrived at all, or
 * `not_offered` for a plain 404 that isn't the contract's (a route this server doesn't have yet).
 */
export type WalkerFailure = WalkerErrorCode | "network" | "not_offered";

/** A failed request. */
export class WalkerApiError extends Error {
  constructor(
    readonly code: WalkerFailure,
    message: string,
    readonly status: number,
    /** With `proposal_closed`: the proposal as it stands now. */
    readonly proposal?: ProposalView,
  ) {
    super(message);
  }
}

const BASE = "/api/v1/walkers";
/**
 * How long each request may take before it counts as failed, so one stalled request (flaky Wi-Fi, a
 * server waking up) never freezes the page. A typed question waits longest: the model has 8 s, then the
 * server may still voice the reply.
 */
export const DEADLINE_MS = { poll: 5_000, turn: 20_000, action: 10_000 } as const;
/**
 * The `Date` header counts whole seconds, so on one machine the estimate wobbles by up to a second. A
 * difference smaller than this is treated as no difference, so countdowns don't jump back and forth.
 */
const CLOCK_SLACK_MS = 2_000;

/** Reads the server's clock from a response's `Date` header and keeps the estimate steady. */
export function nextClockOffset(current: number, dateHeader: string | null, receivedAtMs: number): number {
  const server = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  if (!Number.isFinite(server)) return current;
  // The header is truncated to the second, so the true time is on average half a second later.
  const estimate = server + 500 - receivedAtMs;
  return Math.abs(estimate - current) > CLOCK_SLACK_MS ? estimate : current;
}

/** The caller's signal plus a deadline. Uses a timer where `AbortSignal.any` is missing (Safari before 17.4). */
function withDeadline(caller: AbortSignal | undefined, ms: number): { signal: AbortSignal; done(): void } {
  if (typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function") {
    return { signal: caller ? AbortSignal.any([caller, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms), done: () => undefined };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  caller?.addEventListener("abort", onAbort);
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", onAbort);
    },
  };
}

export function createWalkerApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): WalkerPageApi {
  let offset = 0;

  async function call<T>(path: string, init: RequestInit, schema: z.ZodType<T> | null, deadlineMs: number): Promise<T> {
    const caller = init.signal ?? undefined;
    const deadline = withDeadline(caller, deadlineMs);
    let response: Response;
    let body: unknown;
    try {
      response = await fetchImpl(path, {
        ...init,
        signal: deadline.signal,
        headers: init.body ? { "Content-Type": "application/json" } : undefined,
        credentials: "same-origin",
        cache: "no-store",
      });
      // A body that isn't JSON is null; one cut off by the deadline is a network failure.
      body =
        response.status === 204
          ? null
          : await response.json().catch((e: unknown) => {
              if (deadline.signal.aborted) throw e;
              return null;
            });
    } catch (error) {
      // The caller's own abort (the tab was hidden) passes through; a deadline or a dropped connection is a network failure.
      if (caller?.aborted) throw error;
      throw new WalkerApiError("network", "Couldn't reach the server.", 0);
    } finally {
      deadline.done();
    }
    offset = nextClockOffset(offset, response.headers.get("date"), Date.now());
    if (!response.ok) {
      const parsed = WalkerErrorSchema.safeParse(body);
      // Anything that isn't one of the contract's errors never reads as a walker that went away: a plain
      // 404 is a route this server doesn't have yet; anything else (a proxy's page) is the server being unavailable.
      if (!parsed.success) {
        const code = response.status === 404 ? "not_offered" : "unavailable";
        throw new WalkerApiError(code, "The server's answer wasn't one the page knows.", response.status);
      }
      const { code, message, proposal } = parsed.data.error;
      throw new WalkerApiError(code, message, response.status, proposal);
    }
    if (!schema) return undefined as T;
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new WalkerApiError("unavailable", "The server's answer didn't match the contract.", response.status);
    return parsed.data;
  }

  const walker = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

  return {
    async listWalkers(signal) {
      const list = await call(BASE, { method: "GET", signal }, WalkerListResponseSchema, DEADLINE_MS.poll);
      return { walkers: list.walkers, activity: list.activity ?? [], speech_paces: list.speech_paces ?? [] };
    },
    createPairingCode() {
      return call(`${BASE}/pairing-codes`, { method: "POST" }, PairingCodeResponseSchema, DEADLINE_MS.action);
    },
    sendTurn(deviceId, clientTurnId, text) {
      return call(
        `${walker(deviceId)}/turns`,
        { method: "POST", body: JSON.stringify({ client_turn_id: clientTurnId, input: { type: "text", text } }) },
        WalkerTurnResponseSchema,
        DEADLINE_MS.turn,
      );
    },
    answerProposal(deviceId, proposalId, answer) {
      return call(
        `${walker(deviceId)}/proposals/${encodeURIComponent(proposalId)}`,
        { method: "POST", body: JSON.stringify({ answer }) },
        AnswerProposalResponseSchema,
        DEADLINE_MS.action,
      );
    },
    setSpeechPace(deviceId, pace) {
      return call(`${walker(deviceId)}/speech-pace`, { method: "PUT", body: JSON.stringify({ speech_pace: pace }) }, SpeechPaceResponseSchema, DEADLINE_MS.action);
    },
    async forgetWalker(deviceId) {
      await call(walker(deviceId), { method: "DELETE" }, null, DEADLINE_MS.action);
    },
    clockOffsetMs: () => offset,
  };
}
