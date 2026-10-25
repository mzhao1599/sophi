import { createHmac, randomBytes, randomInt } from "node:crypto";
import {
  ApproveJoinResponseSchema,
  CIRCLE_ERROR_STATUS,
  CareLiveResponseSchema,
  CIRCLE_INVITE_TTL_MS,
  CIRCLE_MESSAGE_RETENTION_MS,
  CreateInviteResponseSchema,
  HelpResponseSchema,
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
  type CareLiveAccess,
  type CareLiveResponse,
  type CircleErrorCode,
  type CircleInvite,
  type CircleMember,
  type HelpResponse,
  type HelpView,
  type JoinCircleRequest,
  type LocationSharingRequest,
  type OwnerPhonesResponse,
  type PhoneHomeResponse,
  type PhoneWalkerView,
  type PhoneMessageView,
  type PhonePerson,
  type PhoneAskForHelpRequest,
  type PhoneSendMessageRequest,
} from "@walker/contracts";
import { HELP_CLOSED_MESSAGE, HELP_NOT_FOUND_MESSAGE, NO_CARETAKER_MESSAGE, answerHelp, askForHelp, helpView, logHelp, type HelpEvent } from "./help";
import { isOnline } from "./rules";
import type { OwnerCaller } from "./service";
import { storable } from "./service";
import { partViews } from "./status";
import {
  SECRET_PATTERN,
  newSecret,
  sha256,
  sweepCircleThrottled,
  type CircleInviteRecord,
  type CircleMemberRecord,
  type CircleMessageRecord,
  type DeviceRecord,
  type HelpAnswer,
  type WalkerStore,
} from "./store";

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
    /** For `help_closed`: the help request as it stands. */
    readonly help?: HelpView,
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
  /** One event per help ask or answer (help.ts): ids, outcomes and timings, never names or locations. */
  onHelp?: (event: HelpEvent) => void;
  /** Set when the circle lives in SpacetimeDB: a signed connection for one subject (`member:<id>`, `owner:<device id>`). */
  liveAccess?: (subject: string) => CareLiveAccess;
}

/** Keys the hash of a client address for the join lockout, apart from pairing's (its own count, same limits). */
const ADDRESS_KEY = randomBytes(32);

export class CircleService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomCode: () => string;
  private readonly blocked: string | undefined;
  private readonly onMessage: (event: MessageEvent) => void;
  private readonly onHelp: (event: HelpEvent) => void;
  private readonly liveAccess: ((subject: string) => CareLiveAccess) | undefined;

  constructor(
    private readonly store: WalkerStore,
    options: CircleServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.randomCode = options.randomCode ?? (() => String(randomInt(0, 1_000_000)).padStart(6, "0"));
    this.blocked = options.blocked;
    this.onMessage = options.onMessage ?? logMessage;
    this.onHelp = options.onHelp ?? logHelp;
    this.liveAccess = options.liveAccess;
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

  /** The owner's page's live connection to this walker's circle; `live: null` when the circle isn't in SpacetimeDB. */
  async ownerLive(caller: OwnerCaller, deviceId: string): Promise<CareLiveResponse> {
    const device = await this.ownerDevice(caller, deviceId);
    return CareLiveResponseSchema.parse({ live: this.liveAccess?.(`owner:${device.device_id}`) ?? null });
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
    // A new phone of hers starts with GPS sharing off, even if turning it off failed when her last phone left.
    if (claim.member.role === "walker_user") await this.store.writeLocationSharing(claim.member.device_id, false);
    return { secret, home: await this.homeFor(claim.member, now) };
  }

  /** The phone's home: waiting, no answer, or in, with the walker's status and its messages. */
  async home(caller: MemberCaller): Promise<PhoneHomeResponse> {
    const member = await this.member(caller);
    return this.homeFor(member, this.now());
  }

  /** This phone's live connection (waiting or in); `live: null` when the circle isn't in SpacetimeDB. */
  async phoneLive(caller: MemberCaller): Promise<CareLiveResponse> {
    const member = await this.member(caller);
    return CareLiveResponseSchema.parse({ live: this.liveAccess?.(`member:${member.member_id}`) ?? null });
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

  // ---- Asking for help (docs/subsystems/help.md; the walker's own routes are in WalkerService) ----

  /** Her own phone's "Ask for help". A caretaker's phone can't ask. `created` picks 201 or 200. */
  async askForHelp(caller: MemberCaller, request: PhoneAskForHelpRequest): Promise<{ created: boolean; response: HelpResponse }> {
    const member = await this.member(caller);
    if (member.state !== "member" || member.role !== "walker_user") throw new CircleError("not_allowed", "Only her own phone can ask for help here.");
    const now = this.now();
    const result = await askForHelp(
      this.store,
      { help_id: this.randomId(), device_id: member.device_id, client_help_id: request.client_help_id, source: "phone", asked_by_member_id: member.member_id },
      now,
      this.onHelp,
    );
    if (result.outcome === "no_caretaker") throw new CircleError("no_caretaker", NO_CARETAKER_MESSAGE);
    // Her phone was removed between reading its cookie and the ask.
    if (result.outcome === "not_found") throw unauthenticated();
    return { created: result.outcome === "created", response: HelpResponseSchema.parse({ help: helpView(result.help, now) }) };
  }

  /** A caretaker's "I'm on my way". Repeating it changes nothing. */
  async helpComing(caller: MemberCaller, helpId: string): Promise<HelpResponse> {
    const member = await this.member(caller);
    if (member.state !== "member" || member.role !== "caregiver") throw new CircleError("not_allowed", "Only a caretaker's phone can say they're on the way.");
    return this.answerHelp(member, helpId, { kind: "coming", member_id: member.member_id });
  }

  /** Her phone's "I'm okay now" (`okay`), or a caretaker's "I'm with her" (`with_her`). */
  async helpOkay(caller: MemberCaller, helpId: string): Promise<HelpResponse> {
    const member = await this.member(caller);
    if (member.state !== "member") throw new CircleError("not_allowed", "The owner hasn't let this phone in yet.");
    return this.answerHelp(member, helpId, { kind: "close", how: member.role === "walker_user" ? "okay" : "with_her", member_id: member.member_id });
  }

  private async answerHelp(member: CircleMemberRecord, helpId: string, answer: HelpAnswer): Promise<HelpResponse> {
    const now = this.now();
    const result = await answerHelp(this.store, member.device_id, helpId, answer, member.role, now, this.onHelp);
    if (result.outcome === "not_found") throw new CircleError("not_found", HELP_NOT_FOUND_MESSAGE);
    if (result.outcome === "not_member") throw unauthenticated();
    const view = HelpResponseSchema.parse({ help: helpView(result.help, now) });
    if (result.outcome === "closed") throw new CircleError("help_closed", HELP_CLOSED_MESSAGE, view.help);
    return view;
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
    const [configuration, circle, messages, help] = await Promise.all([
      this.store.currentConfiguration(device.device_id),
      this.store.circleOf(device.device_id, now),
      this.store.messagesFor(device.device_id, member.member_id, now),
      // A caretaker's answer that carries an open request is how `shown_to` learns its app has it.
      this.store.helpOf(device.device_id, now, member.role === "caregiver" ? member.member_id : null),
    ]);
    const online = isOnline(device.last_heartbeat_at, now);
    const names = new Map(circle.members.map((m) => [m.member_id, m.name]));
    const herPhoneIn = circle.members.some((m) => m.role === "walker_user" && m.state === "member");
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
        // Sharing counts only while her own phone is in: if turning it off failed when her phone left, it stays hidden.
        ...(device.location_sharing_enabled && herPhoneIn
          ? { location_sharing_enabled: true, location: visibleLocation(device, member.role, online, now), route: visibleRoute(device, member.role, online, now) }
          : {}),
      },
      people: circle.members.filter((m) => m.state === "member").map(person),
      messages: messages.map((m) => messageView(m, member.member_id, names)),
      // Her phone and every approved caretaker see the walker's request, a caretaker who joined after the ask too.
      help: help ? helpView(help, now) : null,
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

/** Her shared fix for a caretaker, with its age in seconds, or null (her own phone, sharing off, offline, stale). */
function sharedFix(device: DeviceRecord, role: CircleMemberRecord["role"], online: boolean, now: Date) {
  if (role !== "caregiver" || !online || !device.location_sharing_enabled || !device.location || !device.location_received_at) return null;
  const age = now.getTime() - Date.parse(device.location_received_at);
  if (!Number.isFinite(age) || age < 0 || age > LOCATION_FIX_MAX_AGE_MS) return null;
  return { fix: device.location, age_seconds: Math.floor(age / 1_000) };
}

function visibleLocation(device: DeviceRecord, role: CircleMemberRecord["role"], online: boolean, now: Date): PhoneWalkerView["location"] {
  const shared = sharedFix(device, role, online, now);
  if (!shared) return null;
  const { latitude, longitude, simulated } = shared.fix;
  return { latitude, longitude, age_seconds: shared.age_seconds, ...(simulated ? { simulated: true } : {}) };
}

/** The route she's on, under the same rules as her fix (it was stored with it). */
function visibleRoute(device: DeviceRecord, role: CircleMemberRecord["role"], online: boolean, now: Date): PhoneWalkerView["route"] {
  const shared = sharedFix(device, role, online, now);
  return shared?.fix.route ? { ...shared.fix.route, age_seconds: shared.age_seconds } : null;
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
