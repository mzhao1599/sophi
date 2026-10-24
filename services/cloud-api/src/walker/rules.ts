import {
  OFFLINE_AFTER_MS,
  checkCuesChange,
  isOpenProposal,
  type ProposalView,
  type WalkerConfiguration,
} from "@walker/contracts";

/**
 * The proposal rules, as pure functions both stores call inside their atomic step, so the in-memory
 * store and Postgres decide the same way. Times are the server's clock only.
 */

/** Online: a heartbeat at most OFFLINE_AFTER_MS ago. A walker that never sent one is offline. */
export function isOnline(lastHeartbeatAt: string | null, now: Date): boolean {
  if (lastHeartbeatAt === null) return false;
  const since = now.getTime() - Date.parse(lastHeartbeatAt);
  return since >= 0 && since <= OFFLINE_AFTER_MS;
}

/** True when an open proposal must now be marked expired: past its expiry, or the walker is offline. */
export function shouldExpire(proposal: Pick<ProposalView, "state" | "expires_at">, lastHeartbeatAt: string | null, now: Date): boolean {
  return proposal.state === "open" && (!isOpenProposal(proposal, now) || !isOnline(lastHeartbeatAt, now));
}

export type Answer = "confirm" | "decline";

/**
 * What answering `proposal` does. `configuration` is set only when a Confirm creates the next version.
 * Anything not open (including one that expires or is superseded at this moment) comes back with
 * `answered: false` and its state as it now stands.
 */
export function decideAnswer(
  proposal: ProposalView,
  answer: Answer,
  current: WalkerConfiguration,
  lastHeartbeatAt: string | null,
  now: Date,
): { proposal: ProposalView; answered: boolean; configuration: WalkerConfiguration | null } {
  if (shouldExpire(proposal, lastHeartbeatAt, now)) return { proposal: { ...proposal, state: "expired" }, answered: false, configuration: null };
  if (proposal.state !== "open") return { proposal, answered: false, configuration: null };
  if (answer === "decline") return { proposal: { ...proposal, state: "declined" }, answered: true, configuration: null };
  // The change was checked against the base version when it was proposed; if that version moved, or the
  // change no longer passes the rules, it is superseded rather than applied to a configuration it wasn't made for.
  if (proposal.base_configuration_version !== current.version || checkCuesChange(current.cues, proposal.cues, current.selected_module_ids) !== null) {
    return { proposal: { ...proposal, state: "superseded" }, answered: false, configuration: null };
  }
  const configuration: WalkerConfiguration = { ...current, version: current.version + 1, cues: [...proposal.cues], created_at: now.toISOString() };
  return { proposal: { ...proposal, state: "confirmed", configuration_version: configuration.version }, answered: true, configuration };
}
