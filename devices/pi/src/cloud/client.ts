import {
  AnswerProposalResponseSchema,
  ConfigurationResponseSchema,
  HeartbeatResponseSchema,
  PairDeviceResponseSchema,
  WalkerErrorSchema,
  WalkerTurnResponseSchema,
  type AnswerProposalResponse,
  type DeviceTurnRequest,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type PairDeviceRequest,
  type PairDeviceResponse,
  type ProposalView,
  type WalkerConfiguration,
  type WalkerErrorCode,
  type WalkerTurnResponse,
} from "@walker/contracts";
import type { z } from "zod";
import { CancelledError, DeadlineError } from "../clock";

/** The walker contract's device routes (packages/contracts/src/walker.ts). */
export const DEVICE_ROUTES = {
  pair: "/api/v1/devices/pair",
  heartbeat: (deviceId: string) => `/api/v1/devices/${encodeURIComponent(deviceId)}/heartbeat`,
  configuration: (deviceId: string) => `/api/v1/devices/${encodeURIComponent(deviceId)}/configuration`,
  turns: (deviceId: string) => `/api/v1/devices/${encodeURIComponent(deviceId)}/turns`,
  proposal: (deviceId: string, proposalId: string) =>
    `/api/v1/devices/${encodeURIComponent(deviceId)}/proposals/${encodeURIComponent(proposalId)}`,
} as const;

/**
 * Why a cloud call failed. `unreachable` and `timeout` count toward going offline; `unauthorized` (401
 * `unauthenticated`) means the credential was revoked or is unknown and the walker must be paired again;
 * `proposal_closed` (409) carries the proposal as it stands.
 */
export type CloudErrorKind =
  | "unreachable"
  | "timeout"
  | "cancelled"
  | "unauthorized"
  | "proposal_closed"
  | "server_error"
  | "rejected"
  | "bad_response";

export class CloudError extends Error {
  override name = "CloudError";
  constructor(
    readonly kind: CloudErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: WalkerErrorCode,
    readonly proposal?: ProposalView,
  ) {
    super(message);
  }
}

/** Every call takes a signal; the service owns the deadlines (on its injected clock). */
export interface CloudClient {
  heartbeat(body: HeartbeatRequest, signal: AbortSignal): Promise<HeartbeatResponse>;
  configuration(signal: AbortSignal): Promise<WalkerConfiguration>;
  turn(body: DeviceTurnRequest, signal: AbortSignal): Promise<WalkerTurnResponse>;
  answerProposal(proposalId: string, answer: "confirm" | "decline", signal: AbortSignal): Promise<AnswerProposalResponse>;
}

/** Plain HTTP is allowed only to this machine (the simulator's fake cloud); everything else needs HTTPS. */
export function checkServerUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The server must use https:// (plain http is only allowed to this machine).");
  }
  return url;
}

/** A reply's speech can be about 2.7 MB of base64; the status view rides along. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Turns a non-2xx answer into a CloudError, reading the contract's error body when there is one. */
export function errorFromResponse(status: number, body: unknown): CloudError {
  const parsed = WalkerErrorSchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : undefined;
  const message = parsed.success ? parsed.data.error.message : `Request refused with ${status}.`;
  if (status === 401) return new CloudError("unauthorized", "The server doesn't accept this walker's credential.", status, code);
  if (status === 409 && code === "proposal_closed") {
    return new CloudError("proposal_closed", "That proposal is no longer open.", status, code, parsed.success ? parsed.data.error.proposal : undefined);
  }
  if (status >= 500) return new CloudError("server_error", `Server error ${status}.`, status, code);
  return new CloudError("rejected", message, status, code);
}

export function toCloudError(error: unknown, signal: AbortSignal): CloudError {
  if (error instanceof CloudError) return error;
  if (signal.aborted) {
    if (signal.reason instanceof DeadlineError) return new CloudError("timeout", signal.reason.message);
    if (signal.reason instanceof CancelledError) return new CloudError("cancelled", "Cancelled.");
  }
  return new CloudError("unreachable", "Couldn't reach the server.");
}

async function request<S extends z.ZodType>(
  server: URL,
  path: string,
  init: { method: "GET" | "POST"; body?: unknown; credential?: string; signal: AbortSignal },
  schema: S,
): Promise<z.infer<S>> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.credential) headers.authorization = `Bearer ${init.credential}`;
  let text: string;
  let status: number;
  try {
    const response = await fetch(new URL(path, server), {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
      redirect: "error",
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    throw toCloudError(error, init.signal);
  }
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new CloudError("bad_response", "Response too large.", status);
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (status < 200 || status > 299) throw errorFromResponse(status, json);
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new CloudError("bad_response", "Response doesn't match the walker contract.", status);
  return parsed.data;
}

/** Pairing runs once from the CLI, before there is a credential. */
export async function pairWithServer(server: string, body: PairDeviceRequest, signal: AbortSignal): Promise<PairDeviceResponse> {
  return request(checkServerUrl(server), DEVICE_ROUTES.pair, { method: "POST", body, signal }, PairDeviceResponseSchema);
}

/** The real client: HTTPS, `Authorization: Bearer <device credential>`, every response checked against the contract. */
export class HttpCloudClient implements CloudClient {
  private readonly server: URL;

  constructor(
    server: string,
    private readonly deviceId: string,
    private readonly credential: string,
  ) {
    this.server = checkServerUrl(server);
  }

  heartbeat(body: HeartbeatRequest, signal: AbortSignal) {
    return request(
      this.server,
      DEVICE_ROUTES.heartbeat(this.deviceId),
      { method: "POST", body, credential: this.credential, signal },
      HeartbeatResponseSchema,
    );
  }

  async configuration(signal: AbortSignal) {
    const response = await request(
      this.server,
      DEVICE_ROUTES.configuration(this.deviceId),
      { method: "GET", credential: this.credential, signal },
      ConfigurationResponseSchema,
    );
    return response.configuration;
  }

  turn(body: DeviceTurnRequest, signal: AbortSignal) {
    return request(
      this.server,
      DEVICE_ROUTES.turns(this.deviceId),
      { method: "POST", body, credential: this.credential, signal },
      WalkerTurnResponseSchema,
    );
  }

  answerProposal(proposalId: string, answer: "confirm" | "decline", signal: AbortSignal) {
    return request(
      this.server,
      DEVICE_ROUTES.proposal(this.deviceId, proposalId),
      { method: "POST", body: { answer }, credential: this.credential, signal },
      AnswerProposalResponseSchema,
    );
  }
}
