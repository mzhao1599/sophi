import { describe, expect, it } from "vitest";
import {
  AnswerCircleItemRequestSchema,
  AnswerCircleItemResponseSchema,
  CIRCLE_ERROR_STATUS,
  CIRCLE_MESSAGE_MAX,
  CircleErrorCodeSchema,
  CircleErrorSchema,
  CircleFeedResponseSchema,
  CircleInviteSchema,
  CircleItemSchema,
  CircleMessageSchema,
  CircleNameSchema,
  CircleSpeechKindSchema,
  CreateInviteRequestSchema,
  CreateSuggestionRequestSchema,
  DEFAULT_SCREEN_CHOICES,
  JoinCircleRequestSchema,
  MemberHomeResponseSchema,
  OwnSettingsRequestSchema,
  OwnerCircleResponseSchema,
  ScreenPressSchema,
  ScreenReportRequestSchema,
  ScreenSettingsSchema,
  ScreenShownSchema,
  ScreenStateSchema,
  SendMessageRequestSchema,
  SuggestionChangeSchema,
  VOICE_CHOICES,
  VoiceChoiceIdSchema,
  WALKER_SETUP,
  WalkerConfigurationSchema,
  applySuggestionChange,
  changesNothing,
  suggestionOutcome,
  type CircleMessage,
  type ScreenState,
  type SuggestionItem,
} from "../src";

const T0 = "2026-10-24T19:00:00.000Z";
const T5 = "2026-10-24T19:05:00.000Z";
const T24 = "2026-10-25T19:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const settings = ScreenSettingsSchema.parse({ version: 1, ...DEFAULT_SCREEN_CHOICES, changed_at: T0 });
const member = { member_id: uuid(1), name: "Cooper", role: "family", joined_at: T0 } as const;
const suggestion: SuggestionItem = {
  item_id: uuid(10),
  state: "waiting",
  created_at: T0,
  expires_at: T5,
  kind: "suggestion",
  from_member_id: uuid(1),
  from_name: "Cooper",
  change: { kind: "text_size", text_size: "largest" },
  result_settings_version: null,
};
const join = {
  item_id: uuid(11),
  state: "waiting",
  created_at: T0,
  expires_at: T5,
  kind: "member_join",
  member_id: uuid(2),
  name: "Cooper",
  role: "family",
  invited_by_name: "Max",
} as const;
const message: CircleMessage = {
  message_id: uuid(20),
  client_message_id: uuid(21),
  from_member_id: uuid(1),
  from_name: "Cooper",
  text: "Dinner at six. I'll pick you u",
  state: "waiting",
  created_at: T0,
  expires_at: T24,
  delivered_at: null,
  opened_at: null,
};

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => expect(schema.safeParse(value).success).toBe(true);
const bad = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => expect(schema.safeParse(value).success).toBe(false);

describe("names and messages", () => {
  it("takes names up to 12 characters on one line", () => {
    ok(CircleNameSchema, "Christabelle");
    expect(CircleNameSchema.parse("  Nan  ")).toBe("Nan");
    bad(CircleNameSchema, "Christabelle1");
    bad(CircleNameSchema, "");
    bad(CircleNameSchema, "   ");
    bad(CircleNameSchema, "Co\noper");
    bad(CircleNameSchema, `Co${String.fromCharCode(0x2028)}oper`);
  });

  it("takes messages of 1 to 30 characters on one line", () => {
    expect(message.text).toHaveLength(CIRCLE_MESSAGE_MAX);
    ok(CircleMessageSchema, message);
    ok(SendMessageRequestSchema, { client_message_id: uuid(3), text: message.text });
    bad(SendMessageRequestSchema, { client_message_id: uuid(3), text: `${message.text}!` });
    bad(SendMessageRequestSchema, { client_message_id: uuid(3), text: "" });
    bad(SendMessageRequestSchema, { client_message_id: uuid(3), text: "Two\nlines" });
    bad(SendMessageRequestSchema, { client_message_id: uuid(3), text: "Hi", from_name: "Max" });
  });

  it("keeps a message's state and its times together", () => {
    ok(CircleMessageSchema, { ...message, state: "delivered", delivered_at: T0 });
    ok(CircleMessageSchema, { ...message, state: "opened", delivered_at: T0, opened_at: T0 });
    bad(CircleMessageSchema, { ...message, state: "delivered" });
    bad(CircleMessageSchema, { ...message, state: "opened", delivered_at: T0 });
    bad(CircleMessageSchema, { ...message, opened_at: T0 });
    bad(CircleMessageSchema, { ...message, expires_at: T0 });
  });
});

describe("settings, voices and suggestions", () => {
  it("versions the screen settings apart from the walker configuration", () => {
    bad(ScreenSettingsSchema, { ...settings, version: 0 });
    bad(ScreenSettingsSchema, { ...settings, text_size: "huge" });
    bad(ScreenSettingsSchema, { ...settings, theme: "auto" });
    bad(ScreenSettingsSchema, { ...settings, voice: "calm" });
    // The walker's configuration is unchanged: it still takes no screen fields.
    bad(WalkerConfigurationSchema, { version: 1, ...WALKER_SETUP, created_at: T0, text_size: "large" });
  });

  it("offers three stock voices by our own ids, never a provider id", () => {
    expect(VOICE_CHOICES.map((v) => v.id)).toEqual(VoiceChoiceIdSchema.options);
    bad(VoiceChoiceIdSchema, "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4");
  });

  it("carries exactly one change, and none for captions", () => {
    ok(SuggestionChangeSchema, { kind: "text_size", text_size: "larger" });
    ok(SuggestionChangeSchema, { kind: "theme", theme: "dark" });
    ok(SuggestionChangeSchema, { kind: "greeting", greeting_name: "Nan" });
    ok(SuggestionChangeSchema, { kind: "greeting", greeting_name: null });
    ok(SuggestionChangeSchema, { kind: "voice", voice: "calm" });
    bad(SuggestionChangeSchema, { kind: "captions", captions: false });
    bad(SuggestionChangeSchema, { kind: "text_size", text_size: "larger", theme: "dark" });
    ok(CreateSuggestionRequestSchema, { client_suggestion_id: uuid(4), change: { kind: "voice", voice: "warm" } });
    bad(CreateSuggestionRequestSchema, { client_suggestion_id: uuid(4), changes: [{ kind: "voice", voice: "warm" }] });
  });

  it("applies one change and spots one that changes nothing", () => {
    const { choices, voice } = applySuggestionChange(DEFAULT_SCREEN_CHOICES, "standard", { kind: "text_size", text_size: "largest" });
    expect(choices).toEqual({ ...DEFAULT_SCREEN_CHOICES, text_size: "largest" });
    expect(voice).toBe("standard");
    expect(applySuggestionChange(DEFAULT_SCREEN_CHOICES, "standard", { kind: "voice", voice: "calm" }).voice).toBe("calm");
    expect(changesNothing(DEFAULT_SCREEN_CHOICES, "standard", { kind: "theme", theme: "light" })).toBe(true);
    expect(changesNothing(DEFAULT_SCREEN_CHOICES, "standard", { kind: "greeting", greeting_name: null })).toBe(true);
    expect(changesNothing(DEFAULT_SCREEN_CHOICES, "standard", { kind: "greeting", greeting_name: "Nan" })).toBe(false);
    expect(changesNothing(DEFAULT_SCREEN_CHOICES, "calm", { kind: "voice", voice: "calm" })).toBe(true);
  });
});

describe("circle items", () => {
  it("parses a waiting suggestion and a waiting join", () => {
    ok(CircleItemSchema, suggestion);
    ok(CircleItemSchema, join);
    bad(CircleItemSchema, { ...join, kind: "join" });
    bad(CircleItemSchema, { ...join, invited_by_name: "Maximilian123" });
    bad(CircleItemSchema, { ...suggestion, expires_at: T0 });
    bad(CircleItemSchema, { ...suggestion, extra: true });
  });

  it("names a settings version exactly when an accepted screen change made one", () => {
    ok(CircleItemSchema, { ...suggestion, state: "accepted", result_settings_version: 2 });
    bad(CircleItemSchema, { ...suggestion, state: "accepted" });
    bad(CircleItemSchema, { ...suggestion, result_settings_version: 2 });
    const voice = { ...suggestion, change: { kind: "voice", voice: "calm" } };
    ok(CircleItemSchema, { ...voice, state: "accepted" });
    bad(CircleItemSchema, { ...voice, state: "accepted", result_settings_version: 2 });
  });

  it("tells the phone every outcome the design shows, and never what she did", () => {
    const online = { online: true, drawn_settings_version: 1 };
    expect(suggestionOutcome(suggestion, online)).toBe("waiting");
    expect(suggestionOutcome(suggestion, { online: false, drawn_settings_version: 1 })).toBe("offline");
    const accepted = { ...suggestion, state: "accepted" as const, result_settings_version: 2 };
    expect(suggestionOutcome(accepted, online)).toBe("accepted");
    expect(suggestionOutcome(accepted, { online: true, drawn_settings_version: null })).toBe("accepted");
    expect(suggestionOutcome(accepted, { online: true, drawn_settings_version: 2 })).toBe("on_the_walker");
    expect(suggestionOutcome(accepted, { online: false, drawn_settings_version: 3 })).toBe("on_the_walker");
    expect(suggestionOutcome({ ...suggestion, state: "accepted", change: { kind: "voice", voice: "calm" } }, online)).toBe("on_the_walker");
    for (const state of ["ignored", "expired"] as const) expect(suggestionOutcome({ ...suggestion, state }, online)).toBe("no_answer");
    bad(CircleItemSchema, { ...suggestion, state: "withdrawn" });
  });

  it("never says On the walker while a change of hers is pending on top", () => {
    // Her screen drew version 2 (the suggestion's), then she made the text smaller offline: the Pi can only
    // report "nothing drawn" until that change reaches the server, so the phone stays at "accepted".
    const accepted = { ...suggestion, state: "accepted" as const, result_settings_version: 2 };
    const pending = { screen_connected: true, settings_pending_local: true, settings_version_drawn: null, messages_held: [] };
    ok(ScreenReportRequestSchema, pending);
    bad(ScreenReportRequestSchema, { ...pending, settings_version_drawn: 2 });
    const report = ScreenReportRequestSchema.parse(pending);
    expect(suggestionOutcome(accepted, { online: true, drawn_settings_version: report.settings_version_drawn })).toBe("accepted");
    // Once it's sent (version 3) and drawn with nothing pending, the phone may say it.
    const synced = ScreenReportRequestSchema.parse({ ...pending, settings_pending_local: false, settings_version_drawn: 3 });
    expect(suggestionOutcome(accepted, { online: true, drawn_settings_version: synced.settings_version_drawn })).toBe("on_the_walker");
  });
});

describe("device routes", () => {
  const feed = { device_id: uuid(99), settings, voice: "standard", owner_name: "Max", members: [member], messages: [message], item: suggestion };

  it("parses the feed, with at most one waiting item", () => {
    ok(CircleFeedResponseSchema, feed);
    ok(CircleFeedResponseSchema, { ...feed, owner_name: null, members: [], messages: [], item: null });
    ok(CircleFeedResponseSchema, { ...feed, item: join });
    bad(CircleFeedResponseSchema, { ...feed, item: { ...suggestion, state: "expired" } });
    bad(CircleFeedResponseSchema, { ...feed, items: [suggestion] });
    bad(CircleFeedResponseSchema, { ...feed, device_id: undefined });
    bad(CircleFeedResponseSchema, { ...feed, members: Array.from({ length: 9 }, (_, i) => ({ ...member, member_id: uuid(30 + i) })) });
  });

  it("accepts or ignores by answer only", () => {
    ok(AnswerCircleItemRequestSchema, { answer: "accept" });
    ok(AnswerCircleItemRequestSchema, { answer: "ignore" });
    bad(AnswerCircleItemRequestSchema, { answer: "confirm" });
    bad(AnswerCircleItemRequestSchema, { answer: "accept", by: "owner" });
    ok(AnswerCircleItemResponseSchema, { item: { ...suggestion, state: "accepted", result_settings_version: 2 }, settings: { ...settings, version: 2 }, voice: "standard" });
  });

  it("takes her own whole settings with the version they were made on", () => {
    ok(OwnSettingsRequestSchema, { base_version: 1, choices: { ...DEFAULT_SCREEN_CHOICES, text_size: "larger" }, voice: "standard" });
    bad(OwnSettingsRequestSchema, { base_version: 1, choices: { text_size: "larger" }, voice: "standard" });
    bad(OwnSettingsRequestSchema, { choices: DEFAULT_SCREEN_CHOICES, voice: "standard" });
  });

  it("reports what the screen drew, and nothing drawn without a screen", () => {
    const report = { screen_connected: true, settings_pending_local: false, settings_version_drawn: 2, messages_held: [uuid(20)] };
    ok(ScreenReportRequestSchema, report);
    ok(ScreenReportRequestSchema, { screen_connected: false, settings_pending_local: false, settings_version_drawn: null, messages_held: [] });
    bad(ScreenReportRequestSchema, { ...report, screen_connected: false });
    bad(ScreenReportRequestSchema, { ...report, messages_held: [uuid(20), uuid(20)] });
    // What's on her screen never goes to the cloud.
    bad(ScreenReportRequestSchema, { ...report, shown_item_id: uuid(10) });
  });
});

describe("owner and member routes", () => {
  it("makes invites with a name, a role and the owner's name", () => {
    ok(CreateInviteRequestSchema, { name: "Cooper", role: "family", owner_name: "Max" });
    ok(CreateInviteRequestSchema, { name: "Ana", role: "caregiver", owner_name: "Max" });
    bad(CreateInviteRequestSchema, { name: "Cooper", role: "owner", owner_name: "Max" });
    bad(CreateInviteRequestSchema, { name: "Cooper", role: "family" });
    const invite = { invite_id: uuid(40), name: "Cooper", role: "family", code: "123456", created_at: T0, expires_at: T5 };
    ok(CircleInviteSchema, invite);
    bad(CircleInviteSchema, { ...invite, code: "12345" });
    ok(OwnerCircleResponseSchema, { owner_name: "Max", members: [member], invites: [invite], joins: [join] });
    bad(OwnerCircleResponseSchema, { owner_name: "Max", members: [], invites: [], joins: [], messages: [] });
  });

  it("joins only with the notice shown", () => {
    ok(JoinCircleRequestSchema, { code: "123456", consent: { circle_data_notice: true } });
    bad(JoinCircleRequestSchema, { code: "123456", consent: { circle_data_notice: false } });
    bad(JoinCircleRequestSchema, { code: "123456" });
    bad(JoinCircleRequestSchema, { code: "123456", consent: { circle_data_notice: true }, name: "Cooper" });
  });

  it("shows a member waiting, not let in, or in", () => {
    ok(MemberHomeResponseSchema, { membership: "waiting", name: "Cooper", role: "family", expires_at: T5 });
    ok(MemberHomeResponseSchema, { membership: "no_answer", name: "Cooper" });
    const look = { choices: DEFAULT_SCREEN_CHOICES, voice: "standard" };
    const walker = {
      walker_name: "Nan's walker",
      online: true,
      last_seen_at: T0,
      simulator: false,
      alerts: ["vibration", "spoken"],
      screen: { current: look, on_the_walker: look },
      parts: null,
    };
    const mine = { item_id: suggestion.item_id, change: suggestion.change, created_at: T0, expires_at: T5, outcome: "waiting" };
    const myMessage = { message_id: uuid(20), client_message_id: uuid(21), text: message.text, created_at: T0, expires_at: T24, outcome: "delivered" };
    const home = {
      membership: "member",
      me: member,
      walker,
      circle: { owner_name: "Max", members: [member] },
      suggestions: [mine],
      messages: [myMessage],
    };
    ok(MemberHomeResponseSchema, home);
    ok(MemberHomeResponseSchema, { ...home, walker: { ...walker, walker_name: null } });
    bad(MemberHomeResponseSchema, { ...home, walker: { ...walker, turns: [] } });
    bad(MemberHomeResponseSchema, { ...home, suggestions: [{ ...mine, outcome: "something_else" }] });
    bad(MemberHomeResponseSchema, { membership: "waiting", name: "Cooper", role: "family", expires_at: T5, walker });
    // Members get projections: no item state, no versions or change times, no delivered or opened times.
    bad(MemberHomeResponseSchema, { ...home, suggestions: [{ ...mine, state: "ignored" }] });
    bad(MemberHomeResponseSchema, { ...home, suggestions: [{ suggestion, outcome: "waiting" }] });
    bad(MemberHomeResponseSchema, { ...home, messages: [{ ...myMessage, opened_at: T0 }] });
    bad(MemberHomeResponseSchema, { ...home, messages: [message] });
    bad(MemberHomeResponseSchema, { ...home, walker: { ...walker, screen: { current: settings, on_the_walker: null } } });
    bad(MemberHomeResponseSchema, { ...home, walker: { ...walker, screen: { current: look, on_the_walker: look, drawn_reported_at: T0 } } });
  });

  it("gives family her screen and caregivers part health, never both", () => {
    const look = { choices: DEFAULT_SCREEN_CHOICES, voice: "standard" };
    const part = { module_id: "voice", instance_id: "pi-usb-audio", health: "ok", simulated: false, in_configuration: true };
    const walker = { walker_name: "Nan's walker", online: true, last_seen_at: T0, simulator: false, alerts: ["vibration"], screen: { current: look, on_the_walker: null }, parts: null };
    const family = { membership: "member", me: member, walker, circle: { owner_name: "Max", members: [] }, suggestions: [], messages: [] };
    const caregiver = { ...family, me: { ...member, role: "caregiver" }, walker: { ...walker, screen: null, parts: [part] } };
    ok(MemberHomeResponseSchema, family);
    ok(MemberHomeResponseSchema, caregiver);
    bad(MemberHomeResponseSchema, { ...family, walker: { ...walker, parts: [part] } });
    bad(MemberHomeResponseSchema, { ...family, walker: { ...walker, screen: null } });
    bad(MemberHomeResponseSchema, { ...caregiver, walker: { ...walker, parts: [part] } });
    bad(MemberHomeResponseSchema, { ...caregiver, walker: { ...walker, screen: null, parts: null } });
  });
});

describe("errors and speech", () => {
  it("has a status for every code", () => {
    expect(Object.keys(CIRCLE_ERROR_STATUS).sort()).toEqual([...CircleErrorCodeSchema.options].sort());
    ok(CircleErrorSchema, { error: { code: "item_closed", message: "Closed.", trace_id: "t", item: { ...suggestion, state: "expired" } } });
    ok(CircleErrorSchema, { error: { code: "settings_conflict", message: "Moved.", trace_id: "t", settings } });
    const waiting = { item_id: uuid(10), change: suggestion.change, created_at: T0, expires_at: T5, outcome: "waiting" };
    ok(CircleErrorSchema, { error: { code: "suggestion_waiting", message: "Waiting.", trace_id: "t", suggestion: waiting } });
    bad(CircleErrorSchema, { error: { code: "suggestion_waiting", message: "Waiting.", trace_id: "t", suggestion: { ...waiting, state: "waiting" } } });
    bad(CircleErrorSchema, { error: { code: "proposal_closed", message: "x", trace_id: "t" } });
  });

  it("names the circle's speech kinds", () => {
    expect(CircleSpeechKindSchema.options).toEqual(["circle_prompt", "circle_message"]);
  });
});

describe("the screen's local contract", () => {
  const base: ScreenState = {
    v: 1,
    revision: 7,
    screen: { state: "ambient", alerts: ["vibration", "spoken"] },
    settings: { ...settings, pending_local: false },
    strip: { link: "online", simulator: false, clock: { local_time: "2026-10-24T19:42:00" } },
  };
  const states: ScreenState["screen"][] = [
    { state: "obstacle", zone: "front_left", distance: { status: "measured", mm: 300 }, simulated: true },
    { state: "obstacle", zone: "front_left", distance: { status: "unknown" }, simulated: false },
    { state: "listening" },
    { state: "answering", heard: "What time is it?", reply: "It's about a quarter to eight.", source: "model", page: 0 },
    { state: "model_offer", proposal_id: uuid(50), from_cues: ["vibration", "spoken"], cues: ["sound", "spoken"] },
    { state: "suggestion", item_id: uuid(10), from_name: "Cooper", change: { kind: "voice", voice: "calm" }, minutes_left: 5, one_moment: false },
    { state: "member_join", item_id: uuid(11), name: "Cooper", role: "family", invited_by_name: "Max", step: "again", minutes_left: 4, one_moment: true },
    { state: "done", result: { kind: "change", change: { kind: "text_size", text_size: "larger" } }, change_back: true },
    { state: "done", result: { kind: "nothing_changed" }, change_back: false },
    { state: "message_waiting", message_id: uuid(20), from_name: "Cooper", more: 0 },
    { state: "message", message_id: uuid(20), from_name: "Cooper", text: message.text },
    { state: "offline" },
    { state: "not_set_up" },
    { state: "my_screen", view: { page: "menu" } },
    { state: "my_screen", view: { page: "circle", index: 1, owner_name: "Max", member, count: 2, confirm_remove: true } },
  ];

  it("parses every state", () => {
    ok(ScreenStateSchema, base);
    for (const screen of states) ok(ScreenStateSchema, { ...base, screen });
    ok(ScreenStateSchema, { ...base, strip: { ...base.strip, clock: null } });
  });

  it("refuses what the screen can't draw honestly", () => {
    bad(ScreenStateSchema, { ...base, v: 2 });
    bad(ScreenStateSchema, { ...base, settings });
    ok(ScreenStateSchema, { ...base, settings: { ...settings, text_size: "large", pending_local: true } });
    bad(ScreenStateSchema, { ...base, screen: { state: "done", result: { kind: "nothing_changed" }, change_back: true } });
    bad(ScreenStateSchema, { ...base, screen: { state: "my_screen", view: { page: "circle", index: 0, owner_name: "Max", member, count: 2, confirm_remove: false } } });
    bad(ScreenStateSchema, { ...base, screen: { state: "my_screen", view: { page: "circle", index: 0, owner_name: "Max", member: null, count: 1, confirm_remove: true } } });
    bad(ScreenStateSchema, { ...base, screen: { state: "message", message_id: uuid(20), from_name: "Cooper", text: `${message.text}!` } });
    bad(ScreenStateSchema, { ...base, screen: { state: "suggestion", ...states[5], minutes_left: 6 } });
    bad(ScreenStateSchema, { ...base, screen: { state: "battery", percent: 80 } });
    bad(ScreenStateSchema, { ...base, strip: { ...base.strip, clock: { local_time: "2026-10-24T19:42:00Z" } } });
    bad(ScreenStateSchema, { ...base, emergency: true });
  });

  it("names the revision and item in what the page posts back", () => {
    ok(ScreenShownSchema, { revision: 7, item_id: uuid(10), settings_version: 1, settings_pending_local: false });
    ok(ScreenShownSchema, { revision: 7, item_id: null, settings_version: 1, settings_pending_local: false });
    bad(ScreenShownSchema, { revision: 7, settings_version: 1, settings_pending_local: false });
    ok(ScreenPressSchema, { revision: 7, action: "confirm" });
    ok(ScreenPressSchema, { revision: 7, action: "not_now" });
    bad(ScreenPressSchema, { revision: 7, action: "accept_for_her" });
    bad(ScreenPressSchema, { action: "confirm" });
  });
});
