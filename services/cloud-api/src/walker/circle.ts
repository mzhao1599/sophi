import { createHmac, randomBytes, randomInt } from "node:crypto";
import {
  ApproveJoinResponseSchema,
  CIRCLE_ERROR_STATUS,
  CIRCLE_INVITE_TTL_MS,
  CIRCLE_MESSAGE_RETENTION_MS,
  CreateInviteResponseSchema,
  MAX_CIRCLE_MEMBERS,
  MAX_LIVE_MESSAGES,
  MAX_OPEN_INVITES,
  OwnerPhonesResponseSchema,
  PAIRING_LOCK_WINDOW_MS,
  PAIRING_MAX_WRONG,
  PHONE_JOIN_TTL_MS,
  PRESET_REPLIES,
  PhoneHomeResponseSchema,
  LOCATION_FIX_MAX_AGE_MS,
  LocationSharingResponseSchema,
  PhoneSendMessageResponseSchema,
  type AddPhoneRequest,
  type ApproveJoinRequest,
  type CircleErrorCode,
  type CircleInvite,
  type CircleMember,
  type JoinCircleRequest,
  type LocationSharingRequest,
  type OwnerPhonesResponse,
  type PhoneHomeResponse,
  type PhoneWalkerView,
  type PhoneMessageView,
  type PhonePerson,
  type PhoneSendMessageRequest,
} from "@walker/contracts";
import { isOnline } from "./rules";
import type { OwnerCaller } from "./service";
import { storable } from "./service";
import { partViews } from "./status";
import { SECRET_PATTERN, newSecret, sha256, sweepCircleThrottled, type CircleInviteRecord, type CircleMemberRecord, type CircleMessageRecord, type DeviceRecord, type WalkerStore } from "./store";

/**
 * The two-phone circle (circle.ts, "The two-phone app"): the owner's page adds her own phone or a
 * caretaker's with a code, and the phones see the walker's status and exchange short messages. Separate
 * from WalkerService on purpose: nothing here reads or writes turns, walker lines, proposals or
 * configurations (it only reads the current configuration's alerts), so the walker assistant and the
 * deployed Pi's path are unchanged. Errors use the circle's own codes (CircleErrorCodeSchema).
 */

export class CircleError extends Error {
  override readonly name = "CircleError";
  constructor(
    readonly code: CircleErrorCode,
    message: string,
  ) {
    super(message);
  }

  get status(): number {
    return CIRCLE_ERROR_STATUS[this.code];
  }
}

/** By shape as well as class, as isWalkerError: a dev server's hot reload can leave instances from an older module. */
export function isCircleError(error: unknown): error is CircleError {
  return error instanceof CircleError || (error instanceof Error && error.name === "CircleError" && "code" in error);
}

/** A phone proves itself with its `walker_member` cookie, and only on /api/v1/circle. */
export type MemberCaller = { kind: "member"; secret: string | undefined };

/** One line per message, for the log: never its words, only its length. */
export interface MessageEvent {
  device_id: string;
  from_role: CircleMemberRecord["role"];
  length: number;
  created: boolean;
}

export interface CircleServiceOptions {
  now?: () => Date;
  randomId?: () => string;
  /** Six digits. */
  randomCode?: () => string;
  /** Set when this server must not serve walkers: every call answers 503 with it. */
  blocked?: string;
  onMessage?: (event: MessageEvent) => void;
}

/** Keys the hash of a client address for the join lockout, apart from pairing's (its own count, same limits). */
const ADDRESS_KEY = randomBytes(32);

export class CircleService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomCode: () => string;
  private readonly blocked: string | undefined;
  private readonly onMessage: (event: MessageEvent) => void;

  constructor(
    private readonly store: WalkerStore,
    options: CircleServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.randomCode = options.randomCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
    this.blocked = options.blocked;
    this.onMessage = options.onMessage ?? logMessage;
  }

  // ---- The owner's page ----

  /** "Add a phone": a one-time code for her own phone or a caretaker's, good for CIRCLE_INVITE_TTL_MS. */
  async addPhone(caller: OwnerCaller, deviceId: string, request: AddPhoneRequest): Promise<{ invite: CircleInvite }> {
    const device = await this.ownerDevice(caller, deviceId);
    const now = this.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      const invite: CircleInviteRecord = storable({
        invite_id: this.randomId(),
        device_id: device.device_id,
        code: this.randomCode(),
        name: request.name,
        role: request.role,
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + CIRCLE_INVITE_TTL_MS).toISOString(),
      });
      const result = await this.store.putInvite(invite, { maxOpen: MAX_OPEN_INVITES, maxMembers: MAX_CIRCLE_MEMBERS }, now);
      if (result === "ok") return CreateInviteResponseSchema.parse({ invite: inviteView(invite) });
      if (result === "walker_user_taken") throw new CircleError("circle_full", "Her own phone is already added. Remove it first to add another.");
      if (result === "circle_full") throw new CircleError("circle_full", `A walker can have ${MAX_CIRCLE_MEMBERS} phones and ${MAX_OPEN_INVITES} open codes. Remove one first.`);
    }
    throw new CircleError("unavailable", "Couldn't make a code just now. Please try again.");
  }

  /** The phones, open codes and caretakers waiting for approval. */
  async ownerCircle(caller: OwnerCaller, deviceId: string): Promise<OwnerPhonesResponse> {
    const device = await this.ownerDevice(caller, deviceId);
    const now = this.now();
    const { members, invites } = await this.store.circleOf(device.device_id, now);
    return OwnerPhonesResponseSchema.parse({
      members: members.filter((m) => m.state === "member").map(memberView),
      invites: invites.map(inviteView),
      joins: members
        .filter((m) => m.state === "waiting" && m.expires_at !== null && Date.parse(m.expires_at) > now.getTime())
        .map((m) => ({ member_id: m.member_id, name: m.name, role: "caregiver", expires_at: m.expires_at })),
    });
  }

  /**
   * The owner approves a waiting caretaker, with the consent line (caregiverConsentLine) confirmed. The lean
   * stand-in for her Confirm on the walker: today's deployed Pi can't show or accept a join.
   */
  async approveJoin(caller: OwnerCaller, deviceId: string, memberId: string, _request: ApproveJoinRequest): Promise<{ member: CircleMember }> {
    const device = await this.ownerDevice(caller, deviceId);
    const member = await this.store.approveJoin(device.device_id, memberId, this.now());
    if (!member) throw new CircleError("not_found", "That phone isn't waiting to join any more. Add it again for a new code.");
    return ApproveJoinResponseSchema.parse({ member: memberView(member) });
  }

  /** Removes a phone (or declines a waiting caretaker), deleting every message to or from it at once. */
  async removeMember(caller: OwnerCaller, deviceId: string, memberId: string): Promise<void> {
    const device = await this.ownerDevice(caller, deviceId);
    if (!(await this.store.removeMember(device.device_id, memberId))) throw notFound();
  }

  // ---- The phones ----

  /**
   * A phone types the code. `clientAddress` keys the wrong-code lockout, with pairing's limits
   * (PAIRING_MAX_WRONG within PAIRING_LOCK_WINDOW_MS) and a count of its own. Her own phone is in at once;
   * a caretaker waits for the owner's approval. A phone that already had a membership leaves it (one per
   * browser), which deletes its messages.
   */
  async join(caller: MemberCaller, request: JoinCircleRequest, clientAddress: string): Promise<{ secret: string; home: PhoneHomeResponse }> {
    await this.begin();
    const now = this.now();
    const secret = newSecret();
    const old = caller.secret && SECRET_PATTERN.test(caller.secret) ? await this.store.memberBySecret(sha256(caller.secret)) : undefined;
    const claim = await this.store.claimInvite({
      code: request.code,
      now,
      member: { member_id: this.randomId(), secret_hash: sha256(secret), created_at: now.toISOString(), replaces_member_id: old?.member_id ?? null },
      waitingUntil: new Date(now.getTime() + PHONE_JOIN_TTL_MS).toISOString(),
      maxMembers: MAX_CIRCLE_MEMBERS,
      address_key: createHmac("sha256", ADDRESS_KEY).update(clientAddress).digest("hex"),
      triesSince: new Date(now.getTime() - PAIRING_LOCK_WINDOW_MS),
      maxWrong: PAIRING_MAX_WRONG,
    });
    if (!claim.ok) {
      switch (claim.reason) {
        case "locked":
          throw new CircleError("invite_locked", "Too many wrong codes from this network. Try again in 10 minutes.");
        case "busy":
          throw new CircleError("rate_limited", "Another try from this network is still running. Try again in a moment.");
        case "circle_full":
          throw new CircleError("circle_full", "This walker has as many phones as it can. Ask the owner to remove one.");
        case "walker_user_taken":
          throw new CircleError("circle_full", "Her own phone is already in. Ask the owner to remove it first.");
        default:
          throw new CircleError("invite_code_invalid", "That code isn't right, or it has expired. Ask for a new one.");
      }
    }
    // Her phone is in now, so its earlier membership goes now; a caretaker's goes when the owner approves.
    if (old && claim.member.state === "member") await this.store.removeMember(old.device_id, old.member_id);
    return { secret, home: await this.homeFor(claim.member, now) };
  }

  /** The phone's home: waiting, no answer, or in, with the walker's status and its messages. */
  async home(caller: MemberCaller): Promise<PhoneHomeResponse> {
    const member = await this.member(caller);
    return this.homeFor(member, this.now());
  }

  /** Her approved phone alone can enable or revoke caregiver GPS sharing. */
  async locationSharing(caller: MemberCaller, request: LocationSharingRequest): Promise<{ enabled: boolean }> {
    const member = await this.member(caller);
    if (member.state !== "member" || member.role !== "walker_user") throw new CircleError("not_allowed", "Only the walker user's phone can change location sharing.");
    if (!(await this.store.setLocationSharing(member.device_id, member.member_id, request.enabled))) throw unauthenticated();
    return LocationSharingResponseSchema.parse({ enabled: request.enabled });
  }

  /** A caretaker types to her phone; her phone sends a preset to one caretaker. */
  async sendMessage(caller: MemberCaller, request: PhoneSendMessageRequest): Promise<{ message: PhoneMessageView }> {
    const member = await this.member(caller);
    if (member.state !== "member") throw new CircleError("not_allowed", "The owner hasn't let this phone in yet.");
    const now = this.now();
    const { members } = await this.store.circleOf(member.device_id, now);
    const inCircle = members.filter((m) => m.state === "member");
    let to: CircleMemberRecord | undefined;
    let text: string;
    if (member.role === "caregiver") {
      if (!("text" in request)) throw new CircleError("not_allowed", "A caretaker's phone types its message.");
      to = inCircle.find((m) => m.role === "walker_user");
      if (!to) throw new CircleError("not_found", "Her phone hasn't joined yet, so there's no one to send this to.");
      text = request.text;
    } else {
      if (!("preset" in request)) throw new CircleError("not_allowed", "Her phone sends one of the ready replies.");
      to = inCircle.find((m) => m.member_id === request.to_member_id && m.role === "caregiver");
      if (!to) throw notFound();
      text = PRESET_REPLIES[request.preset];
    }
    const record: CircleMessageRecord = storable({
      message_id: this.randomId(),
      device_id: member.device_id,
      client_message_id: request.client_message_id,
      from_member_id: member.member_id,
      to_member_id: to.member_id,
      text,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CIRCLE_MESSAGE_RETENTION_MS).toISOString(),
    });
    const saved = await this.store.saveMessage(record, MAX_LIVE_MESSAGES, now);
    if (!saved) throw notFound();
    if (saved === "cleared") throw new CircleError("message_limit", "That message was sent earlier and has since been cleared for newer ones, so it wasn't sent again.");
    this.onMessage({ device_id: member.device_id, from_role: member.role, length: [...saved.message.text].length, created: saved.created });
    const names = new Map(members.map((m) => [m.member_id, m.name]));
    return PhoneSendMessageResponseSchema.parse({ message: messageView(saved.message, member.member_id, names) });
  }

  // ---- Shared ----

  private async homeFor(member: CircleMemberRecord, now: Date): Promise<PhoneHomeResponse> {
    if (member.state === "waiting") {
      const lapsed = member.expires_at === null || Date.parse(member.expires_at) <= now.getTime();
      return PhoneHomeResponseSchema.parse(
        lapsed ? { membership: "no_answer", name: member.name } : { membership: "waiting", name: member.name, role: "caregiver", expires_at: member.expires_at },
      );
    }
    const device = await this.store.circleDevice(member.device_id);
    // Forgotten between the member read and this one: the cascade took the member too.
    if (!device) throw unauthenticated();
    const [configuration, circle, messages] = await Promise.all([
      this.store.currentConfiguration(device.device_id),
      this.store.circleOf(device.device_id, now),
      this.store.messagesFor(device.device_id, member.member_id, now),
    ]);
    const online = isOnline(device.last_heartbeat_at, now);
    const names = new Map(circle.members.map((m) => [m.member_id, m.name]));
    return PhoneHomeResponseSchema.parse({
      membership: "member",
      me: person(member),
      walker: {
        walker_name: device.name,
        online,
        simulator: device.manifest?.simulator ?? false,
        alerts: configuration.cues,
        parts: member.role === "caregiver" ? partViews(device, configuration, online) : null,
        battery: "not_measured",
        ...(device.location_sharing_enabled ? { location_sharing_enabled: true, location: visibleLocation(device, member.role, online, now) } : {}),
      },
      people: circle.members.filter((m) => m.state === "member").map(person),
      messages: messages.map((m) => messageView(m, member.member_id, names)),
    });
  }

  private async ownerDevice(caller: OwnerCaller, deviceId: string): Promise<DeviceRecord> {
    await this.begin();
    if (!caller.secret || !SECRET_PATTERN.test(caller.secret)) throw new CircleError("unauthenticated", "This browser hasn't paired a walker yet.");
    const device = await this.store.deviceForOwner(deviceId, sha256(caller.secret));
    if (!device) throw new CircleError("not_found", "This walker wasn't found. It may have been forgotten.");
    await sweepCircleThrottled(this.store, this.now());
    return device;
  }

  /** The phone's membership; the sweep runs only once it is found, so a forged cookie can't start one. */
  private async member(caller: MemberCaller): Promise<CircleMemberRecord> {
    await this.begin();
    if (!caller.secret || !SECRET_PATTERN.test(caller.secret)) throw unauthenticated();
    const member = await this.store.memberBySecret(sha256(caller.secret));
    if (!member) throw unauthenticated();
    await sweepCircleThrottled(this.store, this.now());
    return member;
  }

  private async begin() {
    if (this.blocked) throw new CircleError("unavailable", this.blocked);
    await this.store.ready();
  }
}

function inviteView(i: CircleInviteRecord): CircleInvite {
  return { invite_id: i.invite_id, name: i.name, role: i.role, code: i.code, created_at: i.created_at, expires_at: i.expires_at };
}

function memberView(m: CircleMemberRecord): CircleMember {
  return { member_id: m.member_id, name: m.name, role: m.role, joined_at: m.joined_at ?? m.created_at };
}

function person(m: CircleMemberRecord): PhonePerson {
  return { member_id: m.member_id, name: m.name, role: m.role };
}

function visibleLocation(device: DeviceRecord, role: CircleMemberRecord["role"], online: boolean, now: Date): PhoneWalkerView["location"] {
  if (role !== "caregiver" || !online || !device.location_sharing_enabled || !device.location || !device.location_received_at) return null;
  const age = now.getTime() - Date.parse(device.location_received_at);
  if (!Number.isFinite(age) || age < 0 || age > LOCATION_FIX_MAX_AGE_MS) return null;
  return { ...device.location, age_seconds: Math.floor(age / 1_000) };
}

function messageView(m: CircleMessageRecord, me: string, names: Map<string, string>): PhoneMessageView {
  return {
    message_id: m.message_id,
    client_message_id: m.client_message_id,
    from_member_id: m.from_member_id,
    // A sender's messages go with them, so the name is always there; the fallback only keeps the shape.
    from_name: names.get(m.from_member_id) ?? "Someone",
    to_member_id: m.to_member_id,
    text: m.text,
    mine: m.from_member_id === me,
  };
}

function logMessage(e: MessageEvent) {
  console.info(`[circle] message device=${e.device_id} from=${e.from_role} length=${e.length} created=${e.created}`);
}

function notFound() {
  return new CircleError("not_found", "That person isn't in this circle any more.");
}

function unauthenticated() {
  return new CircleError("unauthenticated", "This phone isn't in a walker's circle. Ask the owner for a code.");
}
