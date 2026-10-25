import {
  CIRCLE_INVITE_TTL_MS,
  CircleInviteSchema,
  CircleMemberSchema,
  CircleNameSchema,
  OwnerPhonesResponseSchema,
  PHONE_JOIN_TTL_MS,
  type Cue,
  type PartView,
} from "@walker/contracts";
import {
  PRESET_REPLIES,
  PhoneApiError,
  PhoneHomeSchema,
  PhoneMessageSchema,
  PhoneTextSchema,
  type OwnerPhonesApi,
  type PhoneApi,
  type PhoneFailure,
  type PhoneHome,
  type PhoneMessage,
  type PhoneRole,
  type PresetReplyId,
} from "./phoneApi";
import { newId } from "./phoneView";

/**
 * An in-memory stand-in for the server's two-phone routes, phone side and owner side, for unit tests, the
 * app's `?preview=` mode ("Preview" on every screen) and `/walker?fake=1` ("Fake walker" banner). It is never
 * the stage path: on stage both phones and the owner's page talk to the real server. Every answer is checked
 * against the contract's schemas, so the fake can't send a shape the server couldn't.
 */

interface Member {
  member_id: string;
  name: string;
  role: PhoneRole;
  approved: boolean;
  joined_at: string;
}

interface Invite {
  invite_id: string;
  name: string;
  role: PhoneRole;
  code: string;
  created_at: string;
  expires_at: string;
}

interface StoredMessage {
  message_id: string;
  client_message_id: string;
  from_member_id: string;
  to_member_id: string;
  text: string;
}

export interface DemoCircle {
  /** A new phone with no cookie. */
  phone(): PhoneApi;
  /** The owner's page for this circle's walker (any device id reaches it). */
  owner(): OwnerPhonesApi;
  /** The owner's "Add a phone", for tests: returns the 6-digit code. */
  addPhone(name: string, role: PhoneRole): string;
  /** The owner approves a waiting caretaker, by name, for tests. */
  approve(name: string): boolean;
  setOnline(online: boolean): void;
  setSimulator(simulator: boolean): void;
  setAlerts(alerts: Cue[]): void;
  /** The next request from any phone or the owner fails with this. */
  failNext(failure: PhoneFailure): void;
  /** Removes a phone by name, as the owner's page would: its cookie then answers 401. */
  remove(name: string): void;
  /** How many requests were made, so a test can tell a path ran. */
  calls(): number;
}

const STATUS: Partial<Record<PhoneFailure, number>> = {
  invalid_request: 400,
  invite_code_invalid: 400,
  unauthenticated: 401,
  not_allowed: 403,
  not_found: 404,
  circle_full: 409,
  message_limit: 409,
  invite_locked: 429,
  unavailable: 503,
  network: 0,
};

function fail(code: PhoneFailure): never {
  throw new PhoneApiError(code, `Fake: ${code}`, STATUS[code] ?? 400);
}

const PARTS = (online: boolean, simulator: boolean): PartView[] =>
  (["base.walker", "controls.hand", "perception.tof", "voice"] as const).map((module_id) => ({
    module_id,
    instance_id: { "base.walker": "pi-01", "controls.hand": "hand-left-01", "perception.tof": "tof-front-01", voice: "voice-01" }[module_id],
    health: online ? "ok" : "unavailable",
    simulated: simulator && (module_id === "controls.hand" || module_id === "perception.tof"),
    in_configuration: true,
  }));

const iso = (ms: number) => new Date(ms).toISOString();

export function createDemoCircle(): DemoCircle {
  let members: Member[] = [];
  let invites: Invite[] = [];
  let messages: StoredMessage[] = [];
  const walker = { walker_name: "My walker", online: true, simulator: false, alerts: ["sound", "spoken"] as Cue[] };
  let locationSharing = false;
  let pending: PhoneFailure | null = null;
  let count = 0;

  function take() {
    count += 1;
    if (pending) {
      const f = pending;
      pending = null;
      fail(f);
    }
  }

  function homeFor(m: Member | undefined): PhoneHome {
    if (!m) fail("unauthenticated");
    if (!m.approved) {
      return PhoneHomeSchema.parse({ membership: "waiting", name: m.name, role: "caregiver", expires_at: iso(Date.parse(m.joined_at) + PHONE_JOIN_TTL_MS) });
    }
    const people = members.filter((p) => p.approved).map(({ member_id, name, role }) => ({ member_id, name, role }));
    return PhoneHomeSchema.parse({
      membership: "member",
      me: { member_id: m.member_id, name: m.name, role: m.role },
      walker: { ...walker, alerts: [...walker.alerts], parts: m.role === "caregiver" ? PARTS(walker.online, walker.simulator) : null, battery: "not_measured", ...(locationSharing ? { location_sharing_enabled: true, location: null } : {}) },
      people,
      messages: messages.filter((x) => x.from_member_id === m.member_id || x.to_member_id === m.member_id).map((x) => view(x, m)),
      // Placeholder until the phones piece fakes help requests (docs/subsystems/help.md).
      help: null,
    });
  }

  function view(x: StoredMessage, m: Member): PhoneMessage {
    const from = members.find((p) => p.member_id === x.from_member_id)!;
    return PhoneMessageSchema.parse({ ...x, from_name: from.name, mine: x.from_member_id === m.member_id });
  }

  function store(m: Member, clientId: string, to: string, text: string): PhoneMessage {
    const again = messages.find((x) => x.from_member_id === m.member_id && x.client_message_id === clientId);
    if (again) return view(again, m);
    const x: StoredMessage = { message_id: newId(), client_message_id: clientId, from_member_id: m.member_id, to_member_id: to, text };
    // The newest 20 are kept; a newer one deletes the oldest.
    messages = [...messages, x].slice(-20);
    return view(x, m);
  }

  function addPhone(name: string, role: PhoneRole) {
    if (invites.length >= 4 || members.length >= 8) fail("circle_full");
    let code: string;
    do code = String(100000 + Math.floor(Math.random() * 900000));
    while (invites.some((i) => i.code === code));
    const now = Date.now();
    const invite: Invite = { invite_id: newId(), name: CircleNameSchema.parse(name), role, code, created_at: iso(now), expires_at: iso(now + CIRCLE_INVITE_TTL_MS) };
    invites.push(invite);
    return invite;
  }

  function removeMember(memberId: string) {
    members = members.filter((p) => p.member_id !== memberId);
    messages = messages.filter((x) => x.from_member_id !== memberId && x.to_member_id !== memberId);
  }

  const circle: DemoCircle = {
    phone() {
      let mine: string | null = null;
      const me = () => members.find((p) => p.member_id === mine);
      const approvedMe = () => {
        const m = me();
        if (!m) fail("unauthenticated");
        if (!m.approved) fail("not_allowed");
        return m;
      };
      return {
        async home() {
          take();
          return homeFor(me());
        },
        async setLocationSharing(enabled) {
          take();
          if (approvedMe().role !== "walker_user") fail("not_allowed");
          locationSharing = enabled;
          return enabled;
        },
        async join(code) {
          take();
          const invite = invites.find((i) => i.code === code);
          if (!/^\d{6}$/.test(code) || !invite) fail("invite_code_invalid");
          invites = invites.filter((i) => i !== invite);
          const m: Member = { member_id: newId(), name: invite.name, role: invite.role, approved: invite.role === "walker_user", joined_at: iso(Date.now()) };
          members.push(m);
          mine = m.member_id;
          return homeFor(m);
        },
        async sendText(clientId, text) {
          take();
          const m = approvedMe();
          if (m.role !== "caregiver") fail("not_allowed");
          const parsed = PhoneTextSchema.safeParse(text);
          if (!parsed.success) fail("invalid_request");
          const her = members.find((p) => p.role === "walker_user" && p.approved);
          if (!her) fail("not_found");
          return store(m, clientId, her.member_id, parsed.data);
        },
        async sendPreset(clientId, preset: PresetReplyId, to) {
          take();
          const m = approvedMe();
          if (m.role !== "walker_user") fail("not_allowed");
          if (!members.some((p) => p.member_id === to && p.approved && p.role === "caregiver")) fail("not_found");
          return store(m, clientId, to, PRESET_REPLIES[preset]);
        },
      };
    },
    owner() {
      return {
        async list() {
          take();
          const now = Date.now();
          invites = invites.filter((i) => Date.parse(i.expires_at) > now);
          return OwnerPhonesResponseSchema.parse({
            members: members.filter((m) => m.approved).map(({ member_id, name, role, joined_at }) => ({ member_id, name, role, joined_at })),
            invites,
            joins: members
              .filter((m) => !m.approved)
              .map((m) => ({ member_id: m.member_id, name: m.name, role: "caregiver", expires_at: iso(Date.parse(m.joined_at) + PHONE_JOIN_TTL_MS) })),
          });
        },
        async addPhone(_deviceId, name, role) {
          take();
          return CircleInviteSchema.parse(addPhone(name, role));
        },
        async approve(_deviceId, memberId) {
          take();
          const m = members.find((p) => p.member_id === memberId && !p.approved);
          if (!m) fail("not_found");
          m.approved = true;
          return CircleMemberSchema.parse({ member_id: m.member_id, name: m.name, role: m.role, joined_at: m.joined_at });
        },
        async remove(_deviceId, memberId) {
          take();
          if (!members.some((p) => p.member_id === memberId)) fail("not_found");
          removeMember(memberId);
        },
      };
    },
    addPhone: (name, role) => addPhone(name, role).code,
    approve(name) {
      const m = members.find((p) => p.name === name && !p.approved);
      if (!m) return false;
      m.approved = true;
      return true;
    },
    setOnline: (online) => void (walker.online = online),
    setSimulator: (simulator) => void (walker.simulator = simulator),
    setAlerts: (alerts) => void (walker.alerts = [...alerts]),
    failNext: (failure) => void (pending = failure),
    remove(name) {
      for (const m of members.filter((p) => p.name === name)) removeMember(m.member_id);
    },
    calls: () => count,
  };
  return circle;
}

/**
 * The preview phone for `?preview=rose` or `?preview=maya`: a circle with Rose's phone and Maya's, and one
 * message each way, seen from one of them. Sample data; the app shows "Preview" on every screen with it.
 */
export async function createPreviewPhone(role: PhoneRole): Promise<{ api: PhoneApi; circle: DemoCircle }> {
  const circle = createDemoCircle();
  circle.setSimulator(true);
  const rose = circle.phone();
  const maya = circle.phone();
  await rose.join(circle.addPhone("Rose", "walker_user"));
  await maya.join(circle.addPhone("Maya", "caregiver"));
  circle.approve("Maya");
  await maya.sendText(newId(), "Lunch is in the fridge.");
  const home = await rose.home();
  const mayaId = home.membership === "member" ? home.people.find((p) => p.role === "caregiver")!.member_id : "";
  await rose.sendPreset(newId(), "okay", mayaId);
  return { api: role === "walker_user" ? rose : maya, circle };
}
