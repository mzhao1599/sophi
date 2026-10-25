import { PAIRING_LOCK_WINDOW_MS } from "@walker/contracts";
import { CareDbError, type CareDbClient } from "./care-db";
import type {
  CircleInviteRecord,
  CircleMemberRecord,
  CircleMessageRecord,
  HelpAnswer,
  HelpAnswerResult,
  HelpAsk,
  HelpAskResult,
  HelpRecord,
  InviteClaim,
  InviteClaimResult,
  PutInviteResult,
  WalkerStore,
} from "./store";

/**
 * The walker store with its circle in SpacetimeDB (docs/interfaces.md, "The care circle on SpacetimeDB").
 * Walker steps (pairing, heartbeats, configurations, turns, GPS) go to the base store as before; each circle
 * step is one procedure of the care-db module, which keeps it atomic with the same rules as the memory and
 * Postgres stores. Where a circle step touches the walker's own rows (her phone removed turns GPS sharing off;
 * forgetting a walker deletes its circle), this class does both, base store first.
 */
export class SpacetimeCircleStore implements WalkerStore {
  constructor(
    private readonly base: WalkerStore,
    private readonly care: CareDbClient,
  ) {}

  // ---- The circle, in SpacetimeDB ----

  async putInvite(invite: CircleInviteRecord, limits: { maxOpen: number; maxMembers: number }, now: Date): Promise<PutInviteResult> {
    return this.care.call("put_invite", { ...invite, max_open: limits.maxOpen, max_members: limits.maxMembers, now: now.toISOString() });
  }

  async circleOf(deviceId: string, now: Date) {
    return this.care.call<{ members: CircleMemberRecord[]; invites: CircleInviteRecord[] }>("circle_of", { device_id: deviceId, now: now.toISOString() });
  }

  async claimInvite(claim: InviteClaim): Promise<InviteClaimResult> {
    try {
      return await this.claim(claim);
    } catch (error) {
      // The call may have committed after we stopped waiting: then the member exists under this phone's new
      // secret, and the code is used up. Find it rather than report a failure the phone would retry.
      if (!(error instanceof CareDbError)) throw error;
      const member = await this.memberBySecret(claim.member.secret_hash).catch(() => undefined);
      if (member) return { ok: true, member };
      throw error;
    }
  }

  private claim(claim: InviteClaim): Promise<InviteClaimResult> {
    return this.care.call("claim_invite", {
      code: claim.code,
      now: claim.now.toISOString(),
      member_id: claim.member.member_id,
      secret_hash: claim.member.secret_hash,
      created_at: claim.member.created_at,
      replaces_member_id: claim.member.replaces_member_id ?? "",
      waiting_until: claim.waitingUntil,
      max_members: claim.maxMembers,
      address_key: claim.address_key,
      tries_since: claim.triesSince.toISOString(),
      max_wrong: claim.maxWrong,
    });
  }

  async memberBySecret(secretHash: string) {
    return (await this.care.call<CircleMemberRecord | null>("member_by_secret", { secret_hash: secretHash })) ?? undefined;
  }

  async approveJoin(deviceId: string, memberId: string, now: Date) {
    const result = await this.care.call<{ member: CircleMemberRecord | null; sharing_reset: string[] }>("approve_join", { device_id: deviceId, member_id: memberId, now: now.toISOString() });
    await this.stopSharing(result.sharing_reset);
    return result.member ?? undefined;
  }

  async removeMember(deviceId: string, memberId: string) {
    const result = await this.care.call<{ removed: boolean; sharing_reset: string[] }>("remove_member", { device_id: deviceId, member_id: memberId });
    await this.stopSharing(result.sharing_reset);
    return result.removed;
  }

  async saveMessage(message: CircleMessageRecord, maxLive: number, now: Date) {
    return this.care.call<{ message: CircleMessageRecord; created: boolean } | "cleared" | null>("save_message", { ...message, max_live: maxLive, now: now.toISOString() });
  }

  async messagesFor(deviceId: string, memberId: string, now: Date) {
    return this.care.call<CircleMessageRecord[]>("messages_for", { device_id: deviceId, member_id: memberId, now: now.toISOString() });
  }

  /**
   * The walker's own sweep calls this from heartbeats and turns, so it never fails them: the module also
   * sweeps itself every minute, so a missed call only delays deletion.
   */
  async sweepCircle(now: Date, lapsedBefore: Date) {
    // The base store drops stale GPS fixes (its circle tables are empty here).
    await this.base.sweepCircle(now, lapsedBefore);
    try {
      await this.care.call("sweep_circle", {
        now: now.toISOString(),
        lapsed_before: lapsedBefore.toISOString(),
        tries_before: new Date(now.getTime() - PAIRING_LOCK_WINDOW_MS).toISOString(),
      });
    } catch (error) {
      if (!(error instanceof CareDbError)) throw error;
      console.warn(`[circle] sweep skipped: ${error.message.slice(0, 120)}`);
    }
  }

  // ---- Help requests: one procedure per step, each one transaction ----

  async askForHelp(ask: HelpAsk, now: Date): Promise<HelpAskResult> {
    return this.care.call("ask_for_help", { ...ask, asked_by_member_id: ask.asked_by_member_id ?? "", now: now.toISOString() });
  }

  async answerHelp(deviceId: string, helpId: string, answer: HelpAnswer, now: Date): Promise<HelpAnswerResult> {
    return this.care.call("answer_help", {
      device_id: deviceId,
      help_id: helpId,
      kind: answer.kind,
      how: answer.kind === "close" ? answer.how : "",
      member_id: answer.member_id ?? "",
      fallback_name: answer.kind === "close" ? answer.fallback_name : "",
      now: now.toISOString(),
    });
  }

  async helpOf(deviceId: string, now: Date) {
    return this.care.call<HelpRecord | null>("help_of", { device_id: deviceId, now: now.toISOString() });
  }

  // ---- Where the circle meets the walker's own rows ----

  /** Only her own approved phone: checked in SpacetimeDB, written to the walker, and checked again after. */
  async setLocationSharing(deviceId: string, memberId: string, enabled: boolean) {
    if (!(await this.isHerPhone(deviceId, memberId))) return false;
    if (!(await this.base.writeLocationSharing(deviceId, enabled))) return false;
    if (enabled && !(await this.isHerPhone(deviceId, memberId))) {
      await this.base.writeLocationSharing(deviceId, false);
      return false;
    }
    return true;
  }

  writeLocationSharing(deviceId: string, enabled: boolean) {
    return this.base.writeLocationSharing(deviceId, enabled);
  }

  /**
   * The circle first: if deleting it fails, the walker is still there to forget again. The other order could
   * leave a circle with no walker, which nothing would ever delete.
   */
  async forget(deviceId: string, ownerHash: string) {
    if (!(await this.base.deviceForOwner(deviceId, ownerHash))) return false;
    await this.care.call("forget_walker", { device_id: deviceId });
    return this.base.forget(deviceId, ownerHash);
  }

  /** The walker store only: Render's health check must not fail, or restart the server, when SpacetimeDB is away. */
  ping() {
    return this.base.ping();
  }

  /** The care database on its own, for the health route's report. */
  async pingCare() {
    await this.care.call("ping", {});
  }

  private async isHerPhone(deviceId: string, memberId: string) {
    const { members } = await this.circleOf(deviceId, new Date());
    return members.some((m) => m.member_id === memberId && m.role === "walker_user" && m.state === "member");
  }

  /**
   * After SpacetimeDB committed the change, so a failure here mustn't report it as failed. A position stays hidden
   * anyway until her phone is back (CircleService.homeFor), and her next phone starts with sharing off (join).
   */
  private async stopSharing(deviceIds: string[]) {
    for (const id of deviceIds) {
      try {
        await this.base.writeLocationSharing(id, false);
      } catch (error) {
        console.warn(`[circle] couldn't turn GPS sharing off for device=${id} (${error instanceof Error ? error.name : "unknown"})`);
      }
    }
  }

  // ---- The walker's own steps: unchanged, in the base store ----

  ready() {
    return this.base.ready();
  }
  circleDevice(deviceId: string) {
    return this.base.circleDevice(deviceId);
  }
  putPairingCode(...args: Parameters<WalkerStore["putPairingCode"]>) {
    return this.base.putPairingCode(...args);
  }
  countDevices(ownerHash: string) {
    return this.base.countDevices(ownerHash);
  }
  claimPairingCode(...args: Parameters<WalkerStore["claimPairingCode"]>) {
    return this.base.claimPairingCode(...args);
  }
  deviceByCredential(credentialHash: string) {
    return this.base.deviceByCredential(credentialHash);
  }
  deviceForOwner(deviceId: string, ownerHash: string) {
    return this.base.deviceForOwner(deviceId, ownerHash);
  }
  devicesForOwner(ownerHash: string) {
    return this.base.devicesForOwner(ownerHash);
  }
  recordHeartbeat(...args: Parameters<WalkerStore["recordHeartbeat"]>) {
    return this.base.recordHeartbeat(...args);
  }
  currentConfiguration(deviceId: string) {
    return this.base.currentConfiguration(deviceId);
  }
  expireProposals(deviceId: string, now: Date) {
    return this.base.expireProposals(deviceId, now);
  }
  openProposal(deviceId: string) {
    return this.base.openProposal(deviceId);
  }
  recentTurns(deviceId: string, limit: number) {
    return this.base.recentTurns(deviceId, limit);
  }
  recentLines(deviceId: string, limit: number) {
    return this.base.recentLines(deviceId, limit);
  }
  answerProposal(...args: Parameters<WalkerStore["answerProposal"]>) {
    return this.base.answerProposal(...args);
  }
  findTurn(deviceId: string, clientTurnId: string) {
    return this.base.findTurn(deviceId, clientTurnId);
  }
  saveTurn(...args: Parameters<WalkerStore["saveTurn"]>) {
    return this.base.saveTurn(...args);
  }
  sweep(...args: Parameters<WalkerStore["sweep"]>) {
    return this.base.sweep(...args);
  }
}
