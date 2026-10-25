import {
  CIRCLE_INVITE_TTL_MS,
  CircleInviteSchema,
  CircleMemberSchema,
  CircleNameSchema,
  HELP_CLOSED_SHOWN_MS,
  HELP_OPEN_MAX_MS,
  HELP_RETENTION_MS,
  HelpViewSchema,
  OwnerPhonesResponseSchema,
  PHONE_JOIN_TTL_MS,
  type Cue,
  type HelpClosedHow,
  type HelpPerson,
  type HelpSource,
  type HelpView,
  type PartView,
  type SharedRoute,
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
import { SAMPLE_AREA } from "./nearbySample";
import { SAMPLE_DESTINATION, SAMPLE_WALK } from "./sampleScreens";
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

interface StoredHelp {
  help_id: string;
  /** Who asked with which client id: her phone's member id, or "walker". */
  asked_by: string;
  client_help_id: string;
  source: HelpSource;
  asked_at: number;
  sent_to: HelpPerson[];
  shown_to: HelpPerson[];
  coming: HelpPerson[];
  closed: { how: HelpClosedHow; by: HelpPerson | null; at: number } | null;
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
  /** Her walker asks for help (both handles held, by voice or its fall check after the countdown). `no_caretaker` fails as the server would. */
  walkerAsks(source: "handles" | "voice" | "camera"): HelpView;
  /** A caretaker, by name, answers the open request: "I'm on my way" or "I'm with Rose". */
  caretakerAnswers(name: string, answer: "coming" | "with_her"): HelpView;
  /** Confirm pressed twice on her walker: closes the open request `okay`, by her phone (null without one). */
  walkerOkay(): HelpView;
  /** Moves the fake's clock on: ages, the hour after which a request expires, and the 24-hour deletion. */
  advance(ms: number): void;
  /** A fresh GPS fix for her walker, shown to caretakers only while her sharing is on. Null clears it. */
  setLocation(at: { latitude: number; longitude: number } | null): void;
  /** The route she's on, shared with the fix (only while sharing is on and there's a fix). */
  setRoute(route: SharedRoute | null): void;
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
  no_caretaker: 409,
  help_closed: 409,
  network: 0,
};

function fail(code: PhoneFailure, help?: HelpView): never {
  throw new PhoneApiError(code, `Fake: ${code}`, STATUS[code] ?? 400, help);
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
  let fix: { latitude: number; longitude: number } | null = null;
  let route: SharedRoute | null = null;
  let helps: StoredHelp[] = [];
  let pending: PhoneFailure | null = null;
  let count = 0;
  // The fake's clock: the real one plus whatever a test or the preview moved it on.
  let skew = 0;
  const now = () => Date.now() + skew;

  /** The server's sweep, as of now: an open request an hour old expires; any request 24 hours old is gone. */
  function sweep() {
    const t = now();
    helps = helps.filter((h) => t - h.asked_at < HELP_RETENTION_MS);
    for (const h of helps) {
      if (!h.closed && t - h.asked_at >= HELP_OPEN_MAX_MS) h.closed = { how: "expired", by: null, at: h.asked_at + HELP_OPEN_MAX_MS };
    }
  }

  const openHelp = () => (sweep(), helps.find((h) => !h.closed));

  function helpView(h: StoredHelp): HelpView {
    return HelpViewSchema.parse({
      help_id: h.help_id,
      source: h.source,
      age_seconds: Math.floor((now() - h.asked_at) / 1_000),
      sent_to: h.sent_to.map((p) => ({ ...p })),
      shown_to: h.shown_to.map((p) => ({ ...p })),
      coming: h.coming.map((p) => ({ ...p })),
      closed: h.closed ? { how: h.closed.how, by: h.closed.by ? { ...h.closed.by } : null } : null,
    });
  }

  /**
   * What every member's home carries: the open request, or the newest closed within HELP_CLOSED_SHOWN_MS, or null.
   * A caretaker's home that carries the open request adds that phone to `shown_to`, as the server does.
   */
  function shownHelp(m: Member): HelpView | null {
    const open = openHelp();
    if (open) {
      if (m.role === "caregiver" && !open.shown_to.some((p) => p.member_id === m.member_id)) open.shown_to.push(person(m));
      return helpView(open);
    }
    const t = now();
    const closed = helps.filter((h) => h.closed && t - h.closed.at < HELP_CLOSED_SHOWN_MS).sort((a, b) => b.closed!.at - a.closed!.at)[0];
    return closed ? helpView(closed) : null;
  }

  function ask(askedBy: string, clientId: string, source: HelpSource): HelpView {
    sweep();
    const again = helps.find((h) => h.asked_by === askedBy && h.client_help_id === clientId);
    if (again) return helpView(again);
    const open = openHelp();
    if (open) return helpView(open);
    const sentTo = members.filter((p) => p.approved && p.role === "caregiver").map(person);
    if (sentTo.length === 0) fail("no_caretaker");
    const h: StoredHelp = { help_id: newId(), asked_by: askedBy, client_help_id: clientId, source, asked_at: now(), sent_to: sentTo, shown_to: [], coming: [], closed: null };
    helps.push(h);
    return helpView(h);
  }

  const person = (m: Pick<Member, "member_id" | "name">): HelpPerson => ({ member_id: m.member_id, name: m.name });

  /** `m` null: her walker's own Confirm with no phone of hers in. */
  function answer(helpId: string | null, m: Member | null, act: "coming" | "okay"): HelpView {
    sweep();
    const h = helpId ? helps.find((x) => x.help_id === helpId) : helps.find((x) => !x.closed);
    if (!h) fail("not_found");
    if (h.closed) fail("help_closed", helpView(h));
    if (act === "coming") {
      if (m?.role !== "caregiver") fail("not_allowed");
      if (!h.coming.some((p) => p.member_id === m.member_id)) h.coming.push(person(m));
    } else {
      h.closed = { how: m?.role === "caregiver" ? "with_her" : "okay", by: m ? person(m) : null, at: now() };
    }
    return helpView(h);
  }

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
      walker: {
        ...walker,
        alerts: [...walker.alerts],
        parts: m.role === "caregiver" ? PARTS(walker.online, walker.simulator) : null,
        battery: "not_measured",
        ...(locationSharing
          ? {
              location_sharing_enabled: true,
              location: m.role === "caregiver" && fix ? { ...fix, age_seconds: 12, ...(walker.simulator ? { simulated: true } : {}) } : null,
              route: m.role === "caregiver" && fix && route ? { ...route, age_seconds: 12 } : null,
            }
          : {}),
      },
      people,
      messages: messages.filter((x) => x.from_member_id === m.member_id || x.to_member_id === m.member_id).map((x) => view(x, m)),
      help: shownHelp(m),
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
          // Turning sharing off erases the last fix, as on the server.
          if (!enabled) fix = null;
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
        async askForHelp(clientId) {
          take();
          const m = approvedMe();
          if (m.role !== "walker_user") fail("not_allowed");
          return ask(m.member_id, clientId, "phone");
        },
        async helpComing(helpId) {
          take();
          return answer(helpId, approvedMe(), "coming");
        },
        async helpOkay(helpId) {
          take();
          return answer(helpId, approvedMe(), "okay");
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
    walkerAsks: (source) => ask("walker", newId(), source),
    caretakerAnswers(name, act) {
      const m = members.find((p) => p.name === name && p.approved && p.role === "caregiver");
      if (!m) fail("not_found");
      return answer(null, m, act === "coming" ? "coming" : "okay");
    },
    walkerOkay() {
      const her = members.find((p) => p.approved && p.role === "walker_user");
      return answer(null, her ?? null, "okay");
    },
    advance: (ms) => void (skew += ms),
    setLocation: (at) => void (fix = at),
    setRoute: (r) => void (route = r),
  };
  return circle;
}

/** What `?preview=` can set up: how many caretakers (0 to 2; Maya's own preview has at least her), and a shared GPS fix. */
export interface PreviewOptions {
  caretakers?: number;
  location?: boolean;
  /** With `location`: she's on the sample's route to the Boating Center. */
  route?: boolean;
}

/** The preview's made-up fix: the sample's starting point by Lake Merritt, never anyone's real position. */
export const PREVIEW_FIX = { latitude: SAMPLE_AREA.start[0], longitude: SAMPLE_AREA.start[1] };

/**
 * The preview phone for `?preview=rose` or `?preview=maya`: a circle with Rose's phone and Maya's (and Ana's,
 * with `caretakers: 2`), and one message each way, seen from one of them. Sample data; the app shows "Preview"
 * on every screen with it, and its preview controls drive the circle (the walker asks, a caretaker answers).
 */
export async function createPreviewPhone(role: PhoneRole, options: PreviewOptions = {}): Promise<{ api: PhoneApi; circle: DemoCircle }> {
  const caretakers = Math.min(2, Math.max(role === "caregiver" ? 1 : 0, options.caretakers ?? 1));
  const circle = createDemoCircle();
  circle.setSimulator(true);
  const rose = circle.phone();
  const maya = circle.phone();
  await rose.join(circle.addPhone("Rose", "walker_user"));
  if (caretakers >= 1) {
    await maya.join(circle.addPhone("Maya", "caregiver"));
    circle.approve("Maya");
    await maya.sendText(newId(), "Lunch is in the fridge.");
  }
  if (caretakers >= 2) {
    await circle.phone().join(circle.addPhone("Ana", "caregiver"));
    circle.approve("Ana");
  }
  if (options.location) {
    await rose.setLocationSharing(true);
    circle.setLocation(options.route ? { latitude: SAMPLE_WALK.at[0], longitude: SAMPLE_WALK.at[1] } : PREVIEW_FIX);
    if (options.route) {
      circle.setRoute({
        destination: SAMPLE_DESTINATION,
        phase: "guiding",
        remaining_m: SAMPLE_WALK.leftM,
        remaining_min: SAMPLE_WALK.leftMin,
        ahead: SAMPLE_WALK.ahead.map(([a, b]) => [a, b] as [number, number]),
        destination_point: [SAMPLE_WALK.end[0], SAMPLE_WALK.end[1]],
        simulated: true,
      });
    }
  }
  const home = await rose.home();
  const mayaId = home.membership === "member" ? home.people.find((p) => p.role === "caregiver")?.member_id : undefined;
  if (mayaId) await rose.sendPreset(newId(), "okay", mayaId);
  return { api: role === "walker_user" ? rose : maya, circle };
}
