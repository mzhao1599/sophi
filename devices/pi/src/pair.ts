import type { PairDeviceResponse } from "@walker/contracts";
import { DeadlineError, withDeadline, type Clock } from "./clock";
import { CloudError, checkHealth, checkServerUrl, pairWithServer } from "./cloud/client";
import type { StateStore } from "./store";
import { SERVICE_VERSION } from "./version";

/** From the contract notes: a sleeping free Render server can take about a minute to wake. */
export const WAKE_DEADLINE_MS = 90_000;
/** Placeholder, not measured: wait between health checks while the server starts. */
export const WAKE_RETRY_MS = 2000;
/** Placeholder, not measured: the pairing request itself, once the server is awake. */
export const PAIR_DEADLINE_MS = 20_000;

class WalkersOff extends Error {}

/**
 * Wakes the server before anything that can't be repeated: `GET /api/v1/health` until it answers 200,
 * retrying refused connections and 503s every WAKE_RETRY_MS, for at most WAKE_DEADLINE_MS in all.
 */
export async function wakeServer(server: string, clock: Clock, say: (line: string) => void): Promise<void> {
  // A URL the client would refuse fails now, not after 90 s of retries.
  checkServerUrl(server);
  say("Waking the server…");
  const start = clock.monotonic();
  for (;;) {
    const remaining = WAKE_DEADLINE_MS - (clock.monotonic() - start);
    if (remaining <= 0) break;
    try {
      // One attempt may wait the whole remaining time: a waking server holds the request open.
      const health = await withDeadline(clock, remaining, (signal) => checkHealth(server, signal));
      if (health === "off") throw new WalkersOff("This server has walkers turned off, so it can't pair a walker.");
      if (health === "ok") return;
    } catch (error) {
      if (error instanceof WalkersOff) throw error;
      if (error instanceof DeadlineError) break;
      // Refused or reset: the server is still starting. Try again shortly.
    }
    if (WAKE_DEADLINE_MS - (clock.monotonic() - start) <= 0) break;
    await new Promise<void>((resolve) => clock.setTimeout(resolve, WAKE_RETRY_MS));
  }
  throw new Error(
    `The server didn't wake up within ${WAKE_DEADLINE_MS / 1000} seconds. Check the URL and try again; the pairing code wasn't used.`,
  );
}

const MAYBE_USED = "The code may have been used: get a new code on the walker page and try again.";

/**
 * A pairing failure in words a person can act on. Never includes the credential (there isn't one yet).
 * Every failure after which the server may have spent the code says so.
 */
export function pairingProblem(error: unknown): string {
  if (error instanceof DeadlineError) {
    return `The server didn't answer the pairing request within ${PAIR_DEADLINE_MS / 1000} seconds. ${MAYBE_USED}`;
  }
  if (!(error instanceof CloudError)) return `${error instanceof Error ? error.message : String(error)} ${MAYBE_USED}`;
  switch (error.code) {
    case "pairing_code_invalid":
      return "That code isn't valid or has expired. Get a new code on the walker page.";
    case "pairing_locked":
      return "Too many wrong codes from this network. Wait 10 minutes, then try a new code.";
    case "walker_limit":
      return "This owner already has the most walkers allowed. Forget one on the walker page first.";
    case "rate_limited":
      return "Another pairing try from this network is still running. Wait a moment, then try again.";
    default:
      if (error.kind === "unreachable") return `The server stopped answering while pairing. ${MAYBE_USED}`;
      if (error.kind === "rejected") return error.message;
      return `${error.kind === "bad_response" ? "The server's answer couldn't be read." : error.message} ${MAYBE_USED}`;
  }
}

/**
 * `walker pair`: wake the server, claim the code exactly once (a code works once, so it is never retried),
 * then adopt the pairing's configuration and save the credential (0600). The configuration is written
 * first: versions restart at 1 for every pairing, so an earlier pairing's configuration must not linger.
 */
export async function pairWalker(options: {
  server: string;
  code: string;
  name?: string;
  store: StateStore;
  clock: Clock;
  say: (line: string) => void;
}): Promise<PairDeviceResponse> {
  const { server, code, name, store, clock, say } = options;
  await wakeServer(server, clock, say);
  let paired: PairDeviceResponse;
  try {
    paired = await withDeadline(clock, PAIR_DEADLINE_MS, (signal) =>
      pairWithServer(server, { code, service_version: SERVICE_VERSION, ...(name ? { name } : {}) }, signal),
    );
  } catch (error) {
    throw new Error(pairingProblem(error));
  }
  try {
    store.writeConfiguration(paired.configuration);
    store.writeCredential({ server_url: server, device_id: paired.device_id, credential: paired.credential });
  } catch (error) {
    throw new Error(`Paired, but the credential couldn't be saved (${(error as Error).message}). ${MAYBE_USED}`);
  }
  return paired;
}
