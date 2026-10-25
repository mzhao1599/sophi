import { z } from "zod";
import { CueListSchema, HELP_COUNTDOWN_MS, HelpClosedHowSchema, HelpViewSchema, InstructionSchema, ManeuverSchema, NavigationPhaseSchema, PartViewSchema, PlaceNameSchema, SharedRouteSchema, SpeechSchema } from "./walker";
import { ModuleIdSchema } from "./catalog";
import { ModuleHealthSchema } from "./device";
import { ZoneDistanceSchema, ZoneNameSchema } from "./serial";
import { MotionFaultCodeSchema, MotionRefusalSchema, confirmPrompt } from "./motion";

/**
 * Sophi Circle, version 1: the people around the person who walks with the walker ("Nan" in the docs), and
 * the walker's own screen. Mostly proposed, not built. Built now: the lean two-phone app ("The two-phone
 * app" below: her own phone and a caretaker's), with its owner and member routes. No Pi code uses any of
 * this file, and nothing outside that section has a route yet.
 *
 * Who calls what (three proofs, none works on another's routes):
 * - the walker (the Pi), with its device credential, on `/api/v1/devices/{id}/circle...`;
 * - the owner's page (the browser that paired), with the `walker_owner` cookie, on `/api/v1/walkers/{id}/circle...`;
 * - a member's web app (family or caregiver), with a `walker_member` cookie, on `/api/v1/circle...`.
 *
 * The rule everything rests on: only a call made with the walker's own device credential can accept a join
 * or a suggestion, so nothing reaches her walker until she presses Confirm on it. No owner or member route
 * accepts anything.
 *
 * This is a separate system from the walker assistant (walker.ts). Nothing here changes a walker.ts or
 * device.ts shape, which today's deployed Pi parses strictly, and `ScreenSettings` is kept apart from
 * `WalkerConfiguration`. An old Pi never calls these routes; an old server answers them `404`.
 *
 * The second half of the file is the walker screen's local contract: what the Pi streams to the screen page
 * on 127.0.0.1 (`ScreenState`) and what the page posts back (`ScreenShown`, `ScreenPress`). Objects are strict.
 */

// ---- Limits and timings ----

/** A member's name, and the owner's, as the walker shows and says it: short enough for the screen at Largest. */
export const CIRCLE_NAME_MAX = 12;
/** A message from a member: short enough to show whole at Largest text with the status strip and a button. */
export const CIRCLE_MESSAGE_MAX = 30;
/** An invite code is good this long after the owner made it, and works once. */
export const CIRCLE_INVITE_TTL_MS = 10 * 60_000;
/** A suggestion, or a join waiting for her Confirm, lapses this long after it was made ("No answer. Nothing changed."). */
export const CIRCLE_ITEM_TTL_MS = 5 * 60_000;
/** Messages are deleted this long after they were sent, opened or not. */
export const CIRCLE_MESSAGE_RETENTION_MS = 24 * 60 * 60_000;
/** Settled suggestions and joins are deleted this long after they were made. */
export const CIRCLE_ITEM_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_CIRCLE_MEMBERS = 8;
export const MAX_OPEN_INVITES = 4;
/** Messages a walker holds at once (not yet deleted), and the most one member may have waiting unopened. */
export const MAX_LIVE_MESSAGES = 20;
export const MAX_UNOPENED_PER_MEMBER = 3;
/** The new Pi polls the circle feed this often. */
export const CIRCLE_FEED_POLL_MS = 2_000;
/** After a `404` from the feed (a server with no circle), the Pi asks again this much later. */
export const CIRCLE_FEED_ABSENT_RETRY_MS = 60_000;

/**
 * The walker's Confirm timing for circle items (Pi-side rule, written here so the screen and the docs agree):
 * a press counts only ACCEPT_GATE_MS after the later of (a) the screen page reporting it has drawn that item's
 * revision and (b) the spoken prompt finishing. With no screen page connected, (b) alone opens it, so a dead
 * kiosk never blocks a join. An earlier press gets a low tone and "One moment".
 */
export const SCREEN_ACCEPT_GATE_MS = 1_500;
/** After any Confirm settles anything (a circle item or today's model offer), presses are ignored this long, each with a low tone. */
export const SETTLE_IGNORE_MS = 2_000;
/** A join's first Confirm arms it ("Press Confirm again"); with no second press within this, it ends as "Nothing changed". */
export const JOIN_ARMED_TTL_MS = 30_000;
/** "Change it back" stays on the Done screen this long. */
export const CHANGE_BACK_MS = 60_000;
/**
 * A card Sophi pulled up (`showing`) stays this long after her turn's answer has finished, or after it was
 * drawn when the answer was already over; a Talk press, an obstacle or a newer card ends it sooner.
 */
export const SCREEN_SHOW_MS = 30_000;

const id = z.uuid();
const time = z.iso.datetime();
const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;
/** One line of plain text: no control characters, no line or paragraph separators. */
const oneLine = /^[^\p{Cc}\p{Zl}\p{Zp}]*$/u;

/** A person's name as typed by the owner (members never name themselves). */
export const CircleNameSchema = z.string().trim().min(1).max(CIRCLE_NAME_MAX).regex(oneLine, "One line, no control characters.");

// ---- Roles, members, invites ----

/**
 * `family` may send messages and suggest changes to her screen and voice. `caregiver` sees whether the walker
 * is online, its part health and the alerts in force, and can send or suggest nothing. Neither sees her
 * conversation, location or activity. The owner is not a member: it's the browser that paired.
 *
 * `walker_user` is her own phone, in the two-phone app only (below). In that app a `caregiver` also exchanges
 * short messages with her phone; `family` isn't used there, and the v1 shapes (MemberHomeResponseSchema)
 * don't describe a `walker_user`.
 */
export const CircleRoleSchema = z.enum(["family", "caregiver", "walker_user"]);
export type CircleRole = z.infer<typeof CircleRoleSchema>;

export const CircleMemberSchema = z.strictObject({
  member_id: id,
  /** From the owner's invite, never chosen by the member. */
  name: CircleNameSchema,
  role: CircleRoleSchema,
  joined_at: time,
});
export type CircleMember = z.infer<typeof CircleMemberSchema>;

/** Made by the owner on the /walker page; an active walker_user code also appears on the walker's home screen. */
export const CircleInviteSchema = z
  .strictObject({
    invite_id: id,
    name: CircleNameSchema,
    role: CircleRoleSchema,
    code: z.string().regex(/^\d{6}$/),
    created_at: time,
    expires_at: time,
  })
  .refine((i) => Date.parse(i.created_at) < Date.parse(i.expires_at), { message: "expires_at is after created_at.", path: ["expires_at"] });
export type CircleInvite = z.infer<typeof CircleInviteSchema>;

// ---- Screen settings and voice ----

export const TextSizeSchema = z.enum(["large", "larger", "largest"]);
export type TextSize = z.infer<typeof TextSizeSchema>;
export const TEXT_SIZES: readonly TextSize[] = TextSizeSchema.options;
export const ScreenThemeSchema = z.enum(["light", "dark"]);
export type ScreenTheme = z.infer<typeof ScreenThemeSchema>;

/** Her choices for her screen, without the version. */
export const ScreenChoicesSchema = z.strictObject({
  text_size: TextSizeSchema,
  theme: ScreenThemeSchema,
  /** "Good evening, Nan" on the clock screen; null shows no greeting. */
  greeting_name: CircleNameSchema.nullable(),
  /** Show Sophi's replies as captions while it answers. Members can't suggest turning these off. */
  captions: z.boolean(),
  /** Read a message aloud as soon as it arrives, instead of when she opens it. */
  read_messages_aloud: z.boolean(),
});
export type ScreenChoices = z.infer<typeof ScreenChoicesSchema>;

/**
 * What a walker's screen starts with: also what the screen draws before its first feed. Dark by default
 * (2026-10-24): the screen is on all day, and a dark page gives off less light and glare. On the walker's
 * backlit LCD it saves little power: the backlight's brightness is what draws the power, not the colours.
 */
export const DEFAULT_SCREEN_CHOICES: ScreenChoices = {
  text_size: "large",
  theme: "dark",
  greeting_name: null,
  captions: true,
  read_messages_aloud: false,
};

/**
 * The walker screen's settings, kept on the server and versioned like the walker's configuration but apart
 * from it (`WalkerConfiguration` is unchanged). Version 1 is DEFAULT_SCREEN_CHOICES, made with the circle.
 * Every change adds the next version and never edits an old one. The only writer is the walker itself: her
 * own changes, and suggestions she accepted. A version is "on the walker" when the walker's screen report
 * says it drew it, not when the server saved it.
 */
export const ScreenSettingsSchema = z.strictObject({
  version: z.int().positive(),
  ...ScreenChoicesSchema.shape,
  changed_at: time,
});
export type ScreenSettings = z.infer<typeof ScreenSettingsSchema>;

/**
 * The stock voices a member may suggest, by our own ids and names. Which Cartesia stock voice each one is
 * stays on the server (never a cloned voice). `standard` is today's voice. The voice is used by the server
 * when it voices her replies; the walker's own voice (Piper, for messages and offline lines) doesn't change.
 */
export const VoiceChoiceIdSchema = z.enum(["standard", "calm", "warm"]);
export type VoiceChoiceId = z.infer<typeof VoiceChoiceIdSchema>;
export const VOICE_CHOICES: readonly { id: VoiceChoiceId; name: string }[] = [
  { id: "standard", name: "Standard" },
  { id: "calm", name: "Calm" },
  { id: "warm", name: "Warm" },
];
export const DEFAULT_VOICE: VoiceChoiceId = "standard";

// ---- Suggestions and joins (circle items) ----

/** Exactly one change. Captions, reading aloud and her circle are hers alone, so there is no suggestion for them. */
export const SuggestionChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text_size"), text_size: TextSizeSchema }),
  z.strictObject({ kind: z.literal("theme"), theme: ScreenThemeSchema }),
  z.strictObject({ kind: z.literal("greeting"), greeting_name: CircleNameSchema.nullable() }),
  z.strictObject({ kind: z.literal("voice"), voice: VoiceChoiceIdSchema }),
]);
export type SuggestionChange = z.infer<typeof SuggestionChangeSchema>;

/** Her choices and voice with one change made. */
export function applySuggestionChange(
  choices: ScreenChoices,
  voice: VoiceChoiceId,
  change: SuggestionChange,
): { choices: ScreenChoices; voice: VoiceChoiceId } {
  switch (change.kind) {
    case "text_size":
      return { choices: { ...choices, text_size: change.text_size }, voice };
    case "theme":
      return { choices: { ...choices, theme: change.theme }, voice };
    case "greeting":
      return { choices: { ...choices, greeting_name: change.greeting_name }, voice };
    case "voice":
      return { choices, voice: change.voice };
  }
}

/** True when the change would leave everything as it is (the server refuses such a suggestion: `unchanged`). */
export function changesNothing(choices: ScreenChoices, voice: VoiceChoiceId, change: SuggestionChange): boolean {
  const next = applySuggestionChange(choices, voice, change);
  return next.voice === voice && (Object.keys(choices) as (keyof ScreenChoices)[]).every((k) => next.choices[k] === choices[k]);
}

/**
 * `waiting` until she answers or it lapses. `accepted` only by the walker's device credential. `ignored`: she
 * tapped Not now, or the walker let it go (a join whose second press never came). `expired`:
 * CIRCLE_ITEM_TTL_MS passed with no answer (doing nothing is a way to say no; Talk doesn't dismiss it). A
 * member's phone never learns which of the last two happened: both read "No answer. Nothing changed.", so it
 * can't tell what she did or was doing. Removing a member (or the member leaving) deletes their items, so the
 * walker's accept or ignore of one then gets `404`, which the Pi shows and says as "Nothing changed."
 */
export const CircleItemStateSchema = z.enum(["waiting", "accepted", "ignored", "expired"]);
export type CircleItemState = z.infer<typeof CircleItemStateSchema>;

const itemBase = {
  item_id: id,
  state: CircleItemStateSchema,
  created_at: time,
  expires_at: time,
};
const expiresAfterCreated = {
  check: (i: { created_at: string; expires_at: string }) => Date.parse(i.created_at) < Date.parse(i.expires_at),
  message: { message: "expires_at is after created_at.", path: ["expires_at"] },
};

/** A family member's suggestion: one change, for her to accept on the walker. */
export const SuggestionItemSchema = z
  .strictObject({
    ...itemBase,
    kind: z.literal("suggestion"),
    from_member_id: id,
    from_name: CircleNameSchema,
    change: SuggestionChangeSchema,
    /**
     * Set exactly when an accepted screen change made (or already had) a settings version: the version that
     * carries it. null for a voice change, which needs no screen version, and for anything not accepted.
     */
    result_settings_version: z.int().positive().nullable(),
  })
  .refine(expiresAfterCreated.check, expiresAfterCreated.message)
  .refine((s) => (s.result_settings_version !== null) === (s.state === "accepted" && s.change.kind !== "voice"), {
    message: "result_settings_version is set exactly when an accepted screen change made one.",
    path: ["result_settings_version"],
  });
export type SuggestionItem = z.infer<typeof SuggestionItemSchema>;

/** Someone who typed an invite code and is waiting for her two Confirm presses. */
export const MemberJoinItemSchema = z
  .strictObject({
    ...itemBase,
    kind: z.literal("member_join"),
    /** The member this join becomes once accepted. */
    member_id: id,
    name: CircleNameSchema,
    role: CircleRoleSchema,
    /** The owner's name as the owner typed it on the invite: "Max invited Cooper". */
    invited_by_name: CircleNameSchema,
  })
  .refine(expiresAfterCreated.check, expiresAfterCreated.message);
export type MemberJoinItem = z.infer<typeof MemberJoinItemSchema>;

export const CircleItemSchema = z.discriminatedUnion("kind", [SuggestionItemSchema, MemberJoinItemSchema]);
export type CircleItem = z.infer<typeof CircleItemSchema>;

/**
 * What a member's phone says about one of their suggestions. Built on the server with `suggestionOutcome`.
 * - `waiting`: "Waiting for Nan" (whether it's on her screen or queued behind something: the phone never says which).
 * - `offline`: still waiting, and her walker is offline.
 * - `accepted`: she accepted it and her screen hasn't drawn it yet (a voice change skips this).
 * - `on_the_walker`: her screen reported drawing the version that carries it, or a later one, with no change
 *   of hers waiting on top (the walker reports no drawn version while one is: see ScreenReportRequestSchema);
 *   for a voice, accepted.
 * - `no_answer`: "No answer. Nothing changed." (ignored or expired alike).
 *
 * `walker.drawn_settings_version` is the last report's `settings_version_drawn`, null when none.
 */
export const SuggestionOutcomeSchema = z.enum(["waiting", "offline", "accepted", "on_the_walker", "no_answer"]);
export type SuggestionOutcome = z.infer<typeof SuggestionOutcomeSchema>;

export function suggestionOutcome(
  item: Pick<SuggestionItem, "state" | "change" | "result_settings_version">,
  walker: { online: boolean; drawn_settings_version: number | null },
): SuggestionOutcome {
  switch (item.state) {
    case "waiting":
      return walker.online ? "waiting" : "offline";
    case "accepted":
      if (item.change.kind === "voice" || item.result_settings_version === null) return "on_the_walker";
      return walker.drawn_settings_version !== null && walker.drawn_settings_version >= item.result_settings_version
        ? "on_the_walker"
        : "accepted";
    default:
      return "no_answer";
  }
}

// ---- Messages ----

/**
 * A short message from a family member to her screen. Never sent to a model, never part of the walker's
 * conversation. `waiting`: the walker hasn't said it holds it. `delivered`: the walker's screen report lists it.
 * `opened`: she opened it (or it was read aloud on arrival, if she turned that on). Deleted
 * CIRCLE_MESSAGE_RETENTION_MS after `created_at`, and at once when its sender is removed or leaves.
 */
export const CircleMessageStateSchema = z.enum(["waiting", "delivered", "opened"]);

export const CircleMessageSchema = z
  .strictObject({
    message_id: id,
    /** The sender's idempotency key: a retried send gets the same message back. */
    client_message_id: id,
    from_member_id: id,
    from_name: CircleNameSchema,
    text: z.string().trim().min(1).max(CIRCLE_MESSAGE_MAX).regex(oneLine, "One line, no control characters."),
    state: CircleMessageStateSchema,
    created_at: time,
    expires_at: time,
    delivered_at: time.nullable(),
    opened_at: time.nullable(),
  })
  .refine((m) => (m.state === "waiting") === (m.delivered_at === null), {
    message: "delivered_at is set once the walker holds it.",
    path: ["delivered_at"],
  })
  .refine((m) => (m.state === "opened") === (m.opened_at !== null), { message: "opened_at is set exactly when opened.", path: ["opened_at"] })
  .refine((m) => Date.parse(m.created_at) < Date.parse(m.expires_at), { message: "expires_at is after created_at.", path: ["expires_at"] });
export type CircleMessage = z.infer<typeof CircleMessageSchema>;

/**
 * How the Pi labels each line it speaks for the circle (its bus `spoke` kinds; Pi-side, written here so every
 * component agrees). Neither kind is ever queued as a heartbeat `WalkerEvent`, so neither reaches the walker's
 * conversation lines or the owner's page.
 * - `circle_prompt`: the Pi's fixed circle lines: "Let Cooper join your circle?", "Press Confirm again to let
 *   Cooper in.", a suggestion's question, "One moment", "Done. Larger text is on.", "Nothing changed.", and a
 *   voice suggestion's sample ("This is how I'd sound.", played from the server's clip).
 * - `circle_message`: a member's message, read aloud. Logged by length only, never its words, like `reply`.
 */
export const CircleSpeechKindSchema = z.enum(["circle_prompt", "circle_message"]);
export type CircleSpeechKind = z.infer<typeof CircleSpeechKindSchema>;

// ---- Device routes (the walker, device credential) ----

/**
 * GET /api/v1/devices/{id}/circle, every CIRCLE_FEED_POLL_MS. Everything the walker needs for its circle and
 * screen, so its cache can always be replaced by the last feed. `device_id` keys that cache: the Pi clears it
 * when the id changes (a re-pair). Messages are every live message for this walker, oldest first; one missing
 * from the feed is deleted from the walker too. `item` is at most one waiting suggestion or join, oldest
 * first; the rest wait their turn on the server.
 */
export const CircleFeedResponseSchema = z.strictObject({
  device_id: id,
  settings: ScreenSettingsSchema,
  voice: VoiceChoiceIdSchema,
  /** The owner's name as last typed on an invite; null until the owner has invited anyone. */
  owner_name: CircleNameSchema.nullable(),
  members: z.array(CircleMemberSchema).max(MAX_CIRCLE_MEMBERS),
  messages: z.array(CircleMessageSchema).max(MAX_LIVE_MESSAGES),
  item: CircleItemSchema.refine((i) => i.state === "waiting", "Only a waiting item is on the walker.").nullable(),
});
export type CircleFeedResponse = z.infer<typeof CircleFeedResponseSchema>;

/**
 * POST /api/v1/devices/{id}/circle/items/{item_id}. The only way anything is accepted. A join is accepted on
 * her second Confirm press (the first only arms it on the Pi); `ignore` settles an item she let go (Not now,
 * or a join whose second press never came). A `404` here means the item is gone (its member was removed or
 * left): the Pi shows and says "Nothing changed."
 */
export const AnswerCircleItemRequestSchema = z.strictObject({ answer: z.enum(["accept", "ignore"]) });
export type AnswerCircleItemRequest = z.infer<typeof AnswerCircleItemRequestSchema>;

export const AnswerCircleItemResponseSchema = z.strictObject({
  item: CircleItemSchema,
  settings: ScreenSettingsSchema,
  voice: VoiceChoiceIdSchema,
});
export type AnswerCircleItemResponse = z.infer<typeof AnswerCircleItemResponseSchema>;

/**
 * PUT /api/v1/devices/{id}/circle/settings: her own change from My screen, or "Change it back". The walker
 * applies it at once (offline too) and sends it when it can, before its next screen report. `base_version` is
 * the version the change was made on; if the server's moved, it answers `409 settings_conflict` with the
 * current settings, and the walker puts her change on top of them and sends it again (her last press wins).
 */
export const OwnSettingsRequestSchema = z.strictObject({
  base_version: z.int().positive(),
  choices: ScreenChoicesSchema,
  voice: VoiceChoiceIdSchema,
});
export type OwnSettingsRequest = z.infer<typeof OwnSettingsRequestSchema>;

export const OwnSettingsResponseSchema = z.strictObject({ settings: ScreenSettingsSchema, voice: VoiceChoiceIdSchema });
export type OwnSettingsResponse = z.infer<typeof OwnSettingsResponseSchema>;

/** POST /api/v1/devices/{id}/circle/messages/{message_id}/opened, no body. */
export const MessageOpenedResponseSchema = z.strictObject({ message: CircleMessageSchema });

/**
 * POST /api/v1/devices/{id}/circle/screen, sent whenever any field changes (and retried until it gets a 2xx).
 * The server keeps the last one; "On the walker" on a member's phone is read from `settings_version_drawn`
 * only. Which item is on her screen is never sent: nothing in the cloud needs it, and it would say what she's
 * doing.
 */
export const ScreenReportRequestSchema = z
  .strictObject({
    /** A screen page is connected to the Pi's local stream now. */
    screen_connected: z.boolean(),
    /** The page's last drawing had a change of hers on top that the server doesn't have yet. */
    settings_pending_local: z.boolean(),
    /**
     * The settings version the page last reported drawing, exactly as the server has it. null when no page is
     * connected, and while a change of hers is pending on top (what's drawn then is no server version), so a
     * phone can never read "On the walker" for something her screen isn't showing.
     */
    settings_version_drawn: z.int().positive().nullable(),
    /** Messages the walker holds (on disk): these read as delivered. */
    messages_held: z.array(id).max(MAX_LIVE_MESSAGES).refine(unique, "Each message appears once."),
  })
  .refine((r) => r.screen_connected || (r.settings_version_drawn === null && !r.settings_pending_local), {
    message: "Nothing is drawn without a screen.",
    path: ["screen_connected"],
  })
  .refine((r) => !r.settings_pending_local || r.settings_version_drawn === null, {
    message: "No drawn version is reported while a change of hers is pending.",
    path: ["settings_version_drawn"],
  });
export type ScreenReportRequest = z.infer<typeof ScreenReportRequestSchema>;

/** GET /api/v1/devices/{id}/circle/voices/{voice}/sample: "This is how I'd sound." in that voice, cached on the server. */
export const VoiceSampleResponseSchema = z.strictObject({ voice: VoiceChoiceIdSchema, speech: SpeechSchema });

// DELETE /api/v1/devices/{id}/circle/members/{member_id}: she removed someone (two taps). 204, no body.

// ---- Owner routes (the /walker page, `walker_owner` cookie, under /api/v1/walkers) ----

/** POST /api/v1/walkers/{id}/circle/invites. `owner_name` is how the walker names the owner ("Max invited Cooper"). */
export const CreateInviteRequestSchema = z.strictObject({
  name: CircleNameSchema,
  role: CircleRoleSchema,
  owner_name: CircleNameSchema,
});
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;
export const CreateInviteResponseSchema = z.strictObject({ invite: CircleInviteSchema });

/** GET /api/v1/walkers/{id}/circle: her circle as the owner manages it. No messages and no suggestions: those are hers. */
export const OwnerCircleResponseSchema = z.strictObject({
  owner_name: CircleNameSchema.nullable(),
  members: z.array(CircleMemberSchema).max(MAX_CIRCLE_MEMBERS),
  /** Open invites, codes included: only the owner sees them. */
  invites: z.array(CircleInviteSchema).max(MAX_OPEN_INVITES),
  /** Joins waiting for her Confirm. */
  joins: z.array(MemberJoinItemSchema).max(MAX_OPEN_INVITES),
});
export type OwnerCircleResponse = z.infer<typeof OwnerCircleResponseSchema>;

// DELETE /api/v1/walkers/{id}/circle/members/{member_id} and /circle/invites/{invite_id}: 204, no body.

// ---- Member routes (the web app, `walker_member` cookie, path /api/v1/circle) ----

/**
 * POST /api/v1/circle/join. No cookie needed; it sets one. The consent is the notice the app showed: "Messages
 * show on Nan's walker screen when she opens them, and are deleted after 24 hours."
 */
export const JoinCircleRequestSchema = z.strictObject({
  code: z.string().regex(/^\d{6}$/),
  consent: z.strictObject({ circle_data_notice: z.literal(true) }),
});
export type JoinCircleRequest = z.infer<typeof JoinCircleRequestSchema>;

/*
 * What members get are projections, not the server's rows: no item state (which would say whether she
 * ignored it), no settings versions or change times (which would say when she was using her screen), no
 * delivered or opened times on messages. Only the outcome words.
 */

/** A member's own suggestion, as the phone shows it. Also the body of `409 suggestion_waiting`. */
export const MemberSuggestionViewSchema = z
  .strictObject({
    item_id: id,
    change: SuggestionChangeSchema,
    created_at: time,
    expires_at: time,
    outcome: SuggestionOutcomeSchema,
  })
  .refine(expiresAfterCreated.check, expiresAfterCreated.message);
export type MemberSuggestionView = z.infer<typeof MemberSuggestionViewSchema>;

/** A member's own message, as the phone shows it: "Waiting for the walker", "Delivered to the walker", "Opened". */
export const MemberMessageViewSchema = z
  .strictObject({
    message_id: id,
    client_message_id: id,
    text: CircleMessageSchema.shape.text,
    created_at: time,
    expires_at: time,
    outcome: CircleMessageStateSchema,
  })
  .refine((m) => Date.parse(m.created_at) < Date.parse(m.expires_at), { message: "expires_at is after created_at.", path: ["expires_at"] });
export type MemberMessageView = z.infer<typeof MemberMessageViewSchema>;

/** Her screen's choices and voice, with no version or time. */
export const MemberScreenLookSchema = z.strictObject({ choices: ScreenChoicesSchema, voice: VoiceChoiceIdSchema });

/**
 * Her walker as a member sees it: status only, never what she's doing or saying. `screen` is for family (the
 * Preview and "On the walker now", which reads its "as of" from `last_seen_at`); `parts` is for caregivers
 * (part health). The other is null (checked on the member response, which knows the role).
 */
export const MemberWalkerViewSchema = z.strictObject({
  /** The walker's own name; null when it has none, and the app then says "the walker". */
  walker_name: z.string().min(1).max(40).nullable(),
  online: z.boolean(),
  last_seen_at: time.nullable(),
  simulator: z.boolean(),
  /** The alerts in force, from the walker's confirmed configuration. */
  alerts: CueListSchema,
  screen: z
    .strictObject({
      /** Her settings on the server now. */
      current: MemberScreenLookSchema,
      /** What her screen last reported drawing (with nothing of hers pending on top); null until it has. */
      on_the_walker: MemberScreenLookSchema.nullable(),
    })
    .nullable(),
  parts: z.array(PartViewSchema).max(32).nullable(),
});
export type MemberWalkerView = z.infer<typeof MemberWalkerViewSchema>;

/**
 * GET /api/v1/circle (and the answer to POST /join). `waiting`: the code was right and the walker is asking
 * her ("Waiting for Nan's walker"). `no_answer`: she didn't let them in before it lapsed ("No answer from Nan's
 * walker. Ask again later."); the cookie then stops working. `member`: "You're in". A removed member's
 * cookie answers `401`.
 */
export const MemberHomeResponseSchema = z.discriminatedUnion("membership", [
  z.strictObject({ membership: z.literal("waiting"), name: CircleNameSchema, role: CircleRoleSchema, expires_at: time }),
  z.strictObject({ membership: z.literal("no_answer"), name: CircleNameSchema }),
  z
    .strictObject({
      membership: z.literal("member"),
      me: CircleMemberSchema,
      walker: MemberWalkerViewSchema,
      circle: z.strictObject({ owner_name: CircleNameSchema.nullable(), members: z.array(CircleMemberSchema).max(MAX_CIRCLE_MEMBERS) }),
      /** This member's own suggestions, newest first; always empty for a caregiver. */
      suggestions: z.array(MemberSuggestionViewSchema).max(10),
      /** This member's own messages still kept, newest first; always empty for a caregiver. */
      messages: z.array(MemberMessageViewSchema).max(MAX_LIVE_MESSAGES),
    })
    .refine(
      (h) =>
        h.me.role === "family"
          ? h.walker.screen !== null && h.walker.parts === null
          : h.walker.screen === null && h.walker.parts !== null && h.suggestions.length === 0 && h.messages.length === 0,
      { message: "Family see her screen settings; caregivers see part health; neither sees the other's.", path: ["walker"] },
    ),
]);
export type MemberHomeResponse = z.infer<typeof MemberHomeResponseSchema>;

/** POST /api/v1/circle/suggestions (family only). A repeated `client_suggestion_id` gets the same suggestion back. */
export const CreateSuggestionRequestSchema = z.strictObject({ client_suggestion_id: id, change: SuggestionChangeSchema });
export type CreateSuggestionRequest = z.infer<typeof CreateSuggestionRequestSchema>;
export const CreateSuggestionResponseSchema = MemberSuggestionViewSchema;

/** POST /api/v1/circle/messages (family only). */
export const SendMessageRequestSchema = z.strictObject({
  client_message_id: id,
  text: CircleMessageSchema.shape.text,
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
export const SendMessageResponseSchema = z.strictObject({ message: MemberMessageViewSchema });

// DELETE /api/v1/circle: leave the circle; deletes this member's messages and suggestions. 204, no body.
// GET /api/v1/circle/voices/{voice}/sample: the sample clip as audio/wav, labelled "Sample" in the app.

// ---- The two-phone app (built: lean, for the demo) ----
//
// Two phones: her own (`walker_user`, a simple mode with a few big tiles and no typing) and a caretaker's
// (`caregiver`). The owner's /walker page adds each phone with a code. Her own phone joins on the code alone.
// A caretaker's join waits until the owner's page approves it with an explicit consent line: the lean
// stand-in for her Confirm on the walker, because today's deployed Pi can't show or accept a join without a
// change to what it parses (walker.ts, device.ts). The member routes are the ones above (`walker_member`
// cookie, path /api/v1/circle) with these shapes. A phone sees whether the walker is online, the alerts in
// force, part health (caretaker only) and the messages between the phones. Never her conversation, her
// location by default or any activity time: the optional current GPS fix below is caregiver-only after
// the walker user's separate opt-in, and carries age rather than a history timestamp.

/** The roles a phone can be added as. */
export const PhoneRoleSchema = z.enum(["walker_user", "caregiver"]);
export type PhoneRole = z.infer<typeof PhoneRoleSchema>;

/** How long a caretaker's join waits for the owner's approval. */
export const PHONE_JOIN_TTL_MS = CIRCLE_ITEM_TTL_MS;

/** POST /api/v1/walkers/{id}/circle/invites ("Add a phone"): her own phone or a caretaker, and their name. → CreateInviteResponseSchema. */
export const AddPhoneRequestSchema = z.strictObject({ name: CircleNameSchema, role: PhoneRoleSchema });
export type AddPhoneRequest = z.infer<typeof AddPhoneRequestSchema>;

/** A caretaker who typed the code and is waiting for the owner's approval. */
export const PendingJoinSchema = z.strictObject({
  member_id: id,
  name: CircleNameSchema,
  role: z.literal("caregiver"),
  expires_at: time,
});
export type PendingJoin = z.infer<typeof PendingJoinSchema>;

/** GET /api/v1/walkers/{id}/circle: the phones as the owner manages them. No messages: those are theirs. */
export const OwnerPhonesResponseSchema = z.strictObject({
  members: z.array(CircleMemberSchema).max(MAX_CIRCLE_MEMBERS),
  /** Open invites, codes included: only the owner sees them. */
  invites: z.array(CircleInviteSchema).max(MAX_OPEN_INVITES),
  joins: z.array(PendingJoinSchema).max(MAX_CIRCLE_MEMBERS),
});
export type OwnerPhonesResponse = z.infer<typeof OwnerPhonesResponseSchema>;

/**
 * The line the owner's page shows beside Approve for a waiting caretaker. The owner approves only after
 * asking her; the server takes an approval only with `walker_user_agreed: true`.
 */
export function caregiverConsentLine(caregiverName: string, walkerUserName: string | null): string {
  const who = walkerUserName ?? "The person who uses this walker";
  return `${who} agreed that ${caregiverName} can see whether the walker is on, its part health and alerts, exchange short messages with ${walkerUserName ? "her" : "them"} (the walker reads ${caregiverName}'s messages aloud), be told when ${walkerUserName ? "she asks" : "they ask"} for help, see a recent GPS position and any walking route in progress only if location sharing is turned on later, and watch the walker's camera live only while camera sharing is on.`;
}

/** POST /api/v1/walkers/{id}/circle/joins/{member_id}: the owner approves a waiting caretaker. Declining is DELETE on the member. */
export const ApproveJoinRequestSchema = z.strictObject({ consent: z.strictObject({ walker_user_agreed: z.literal(true) }) });
export type ApproveJoinRequest = z.infer<typeof ApproveJoinRequestSchema>;
export const ApproveJoinResponseSchema = z.strictObject({ member: CircleMemberSchema });

/** Her phone sends one of these with one tap; it never types. */
export const PresetReplyIdSchema = z.enum(["okay", "call_me", "on_my_way"]);
export type PresetReplyId = z.infer<typeof PresetReplyIdSchema>;
export const PRESET_REPLIES: Readonly<Record<PresetReplyId, string>> = {
  okay: "I'm okay",
  call_me: "Can you call me?",
  on_my_way: "I'm on my way",
};

/**
 * POST /api/v1/circle/messages in the two-phone app. A caretaker types (to her phone); her phone sends a
 * preset to one caretaker. A repeated `client_message_id` from the same phone gets the same message back.
 * Each walker keeps its newest MAX_LIVE_MESSAGES; a newer one deletes the oldest. Each is deleted
 * CIRCLE_MESSAGE_RETENTION_MS after it was sent, and at once when either phone is removed.
 */
export const PhoneSendMessageRequestSchema = z.union([
  z.strictObject({ client_message_id: id, text: CircleMessageSchema.shape.text }),
  z.strictObject({ client_message_id: id, preset: PresetReplyIdSchema, to_member_id: id }),
]);
export type PhoneSendMessageRequest = z.infer<typeof PhoneSendMessageRequestSchema>;

/** The Pi submits this only after a fresh physical Confirm press on a spoken draft. */
export const DeviceSendMessageRequestSchema = z.strictObject({
  client_message_id: id,
  to_member_id: id,
  text: CircleMessageSchema.shape.text,
});
export type DeviceSendMessageRequest = z.infer<typeof DeviceSendMessageRequestSchema>;
export const DeviceSendMessageResponseSchema = z.strictObject({ sent: z.literal(true) });

/** How many of her newest incoming messages the walker is sent; it reads new ones aloud and replays the newest. */
export const WALKER_MESSAGES_KEPT = 5;

/** A caretaker's message to her phone, as her walker hears it: no member ids, no times, no read state. */
export const WalkerIncomingMessageSchema = z.strictObject({
  message_id: id,
  from_name: CircleNameSchema,
  text: CircleMessageSchema.shape.text,
});
export type WalkerIncomingMessage = z.infer<typeof WalkerIncomingMessageSchema>;

/**
 * GET /api/v1/devices/{id}/messages (the walker's Bearer credential): the newest WALKER_MESSAGES_KEPT messages an
 * approved caretaker sent to her phone that haven't been deleted, oldest first. Empty when she has no phone in.
 * A message deleted on the server (24 hours, or a phone removed) drops out of the next answer.
 */
export const DeviceMessagesResponseSchema = z.strictObject({
  /** Active code for the walker user only; never a caretaker invite. */
  companion_code: z.strictObject({ code: CircleInviteSchema.shape.code, expires_at: time }).nullable().optional(),
  messages: z
    .array(WalkerIncomingMessageSchema)
    .max(WALKER_MESSAGES_KEPT)
    .refine((m) => new Set(m.map((x) => x.message_id)).size === m.length, "Each message_id appears once."),
});
export type DeviceMessagesResponse = z.infer<typeof DeviceMessagesResponseSchema>;

/** A message between the phones, as either phone sees it: no times and no read state. */
export const PhoneMessageViewSchema = z.strictObject({
  message_id: id,
  client_message_id: id,
  from_member_id: id,
  from_name: CircleNameSchema,
  to_member_id: id,
  text: CircleMessageSchema.shape.text,
  /** This phone sent it. */
  mine: z.boolean(),
});
export type PhoneMessageView = z.infer<typeof PhoneMessageViewSchema>;
export const PhoneSendMessageResponseSchema = z.strictObject({ message: PhoneMessageViewSchema });

/** A person in the circle as a phone sees them: no join time. */
export const PhonePersonSchema = z.strictObject({ member_id: id, name: CircleNameSchema, role: PhoneRoleSchema });
export type PhonePerson = z.infer<typeof PhonePersonSchema>;

/** Her walker as a phone sees it: status only, with no last-seen time. */
export const PhoneWalkerViewSchema = z.strictObject({
  /** The walker's own name, as it was paired ("My walker" by default). */
  walker_name: z.string().min(1).max(40),
  online: z.boolean(),
  simulator: z.boolean(),
  /** The alerts in force, from the walker's current configuration. */
  alerts: CueListSchema,
  /** Part health, for a caretaker; null on her own phone. */
  parts: z.array(PartViewSchema).max(32).nullable(),
  /** No walker measures its battery yet: the app says "Battery: not measured on this walker". */
  battery: z.literal("not_measured"),
  /**
   * Caregiver only; null when off, stale, offline or no fix. Never shown on the walker user's phone.
   * `simulated` (added 2026-10-25): the simulator's walk, which the phone labels Simulated.
   */
  location: z
    .strictObject({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      age_seconds: z.int().min(0).max(60),
      simulated: z.boolean().optional(),
    })
    .nullable()
    .optional(),
  /**
   * Caregiver only, added 2026-10-25: the walking route she's on (SharedRouteSchema) with how old it is, under
   * the same rules as `location` (sharing on, online, recent). null with no route; absent on an older server.
   */
  route: SharedRouteSchema.extend({ age_seconds: z.int().min(0).max(60) }).nullable().optional(),
  /** The walker user may see the toggle state. A caregiver may see it, but cannot change it. */
  location_sharing_enabled: z.boolean().optional(),
});
export type PhoneWalkerView = z.infer<typeof PhoneWalkerViewSchema>;

/** PUT /api/v1/circle/location-sharing, only from the walker user's member cookie. Revocation needs no consent flag. */
export const LocationSharingRequestSchema = z.union([
  z.strictObject({ enabled: z.literal(true), consent: z.literal(true) }),
  z.strictObject({ enabled: z.literal(false) }),
]);
export const LocationSharingResponseSchema = z.strictObject({ enabled: z.boolean() });
export type LocationSharingRequest = z.infer<typeof LocationSharingRequestSchema>;

// ---- Asking for help (added 2026-10-24, docs/subsystems/help.md) ----
//
// She asks her caretakers for help from the walker (both handle buttons held, or by voice after a countdown she
// can stop) or from her own phone (one big button). It is sent to every approved caretaker phone in the circle,
// shows on each one whose app is open, and each can answer "I'm on my way". It closes when she says she's okay (her phone, or Confirm twice on the
// walker), when a caretaker says they're with her, or after HELP_OPEN_MAX_MS. Sophi never calls an emergency
// number and sends no SMS: it tells the caretaker phones that have the app open (no push notifications yet).
// The caretaker sees her location only through the existing opt-in (`PhoneWalkerView.location`); asking for
// help never turns sharing on. The walker never says "emergency" (the screen's calm-wording rule).

// The shared shapes (HelpViewSchema, the HELP_* timings, the device routes' bodies) are in walker.ts, so the
// walker's error envelope can carry a request. The phone routes are below.

/** POST /api/v1/circle/help, from her own phone only (`not_allowed` from a caretaker). Same rules as the walker's. */
export const PhoneAskForHelpRequestSchema = z.strictObject({ client_help_id: id });
export type PhoneAskForHelpRequest = z.infer<typeof PhoneAskForHelpRequestSchema>;

// POST /api/v1/circle/help/{help_id}/coming, no body, a caretaker's phone only: "I'm on my way". Repeating it
// changes nothing. → HelpResponseSchema; `409 help_closed` once closed. Phone help routes answer errors in the
// circle envelope (CircleErrorSchema).
// POST /api/v1/circle/help/{help_id}/okay, no body: from her phone, "I'm okay now" (`okay`); from a caretaker's
// phone, "I'm with Rose" (`with_her`). → HelpResponseSchema; `409 help_closed` once closed.

/** Names joined the way the walker says them ("Maya", "Maya and Sam", "Maya, Sam and Lee"), for its fixed lines. */
export function helpNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * GET /api/v1/circle in the two-phone app, and the answer to POST /api/v1/circle/join. `waiting`: a
 * caretaker's code was right and the owner hasn't approved yet. `no_answer`: it wasn't approved in time
 * (the phone joins again with a new code). `member`: in. A removed phone's cookie answers `401`.
 */
export const PhoneHomeResponseSchema = z.discriminatedUnion("membership", [
  z.strictObject({ membership: z.literal("waiting"), name: CircleNameSchema, role: z.literal("caregiver"), expires_at: time }),
  z.strictObject({ membership: z.literal("no_answer"), name: CircleNameSchema }),
  z
    .strictObject({
      membership: z.literal("member"),
      me: PhonePersonSchema,
      walker: PhoneWalkerViewSchema,
      /** Everyone in, this phone included, in joining order. */
      people: z.array(PhonePersonSchema).max(MAX_CIRCLE_MEMBERS),
      /** The messages to or from this phone still kept, oldest first. */
      messages: z.array(PhoneMessageViewSchema).max(MAX_LIVE_MESSAGES),
      /**
       * The walker's open help request, or the newest closed within HELP_CLOSED_SHOWN_MS, or null. On her phone and
       * on every caretaker's phone (a caretaker joined after she asked sees it too, but isn't in `told`).
       */
      help: HelpViewSchema.nullable(),
    })
    .refine((h) => (h.me.role === "caregiver") === (h.walker.parts !== null), {
      message: "A caretaker sees part health; her own phone doesn't.",
      path: ["walker", "parts"],
    }),
]);
export type PhoneHomeResponse = z.infer<typeof PhoneHomeResponseSchema>;

// ---- Live updates from SpacetimeDB (docs/interfaces.md, "The care circle on SpacetimeDB") ----

/**
 * Where a phone or the owner's page connects for live updates, with its own short-lived token. `live: null`
 * when this server keeps the circle itself (no SpacetimeDB settings): the page then keeps polling.
 */
export const CareLiveAccessSchema = z.strictObject({
  uri: z.url(),
  database: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  token: z.string().min(1),
  expires_at: z.iso.datetime(),
});
export type CareLiveAccess = z.infer<typeof CareLiveAccessSchema>;

export const CareLiveResponseSchema = z.strictObject({ live: CareLiveAccessSchema.nullable() });
export type CareLiveResponse = z.infer<typeof CareLiveResponseSchema>;

// ---- Errors ----

export const CircleErrorCodeSchema = z.enum([
  "invalid_request",
  /** No cookie or credential, or one the server doesn't know (a removed member, a forgotten walker). */
  "unauthenticated",
  /**
   * The caller's role can't do this: in v1, a caregiver sending or suggesting. In the two-phone app: a phone
   * still waiting to be approved sending, her phone typing instead of sending a preset, a caretaker sending a preset.
   */
  "not_allowed",
  /** Unknown id, or one that belongs to someone else: the two look the same. */
  "not_found",
  "invite_code_invalid",
  /** Too many wrong codes from this client address recently (the pairing lockout's limits). */
  "invite_locked",
  /** MAX_CIRCLE_MEMBERS members, or MAX_OPEN_INVITES open invites, already. */
  "circle_full",
  /** A suggestion while her walker is offline: "Nan's walker is offline. Try again when it's back." */
  "walker_offline",
  /** This member already has a suggestion waiting; the body carries it. */
  "suggestion_waiting",
  /** The suggestion would change nothing. */
  "unchanged",
  /** The item isn't waiting any more; the body carries it as it stands, so a retried accept that won sees `accepted`. */
  "item_closed",
  /** `base_version` isn't the current version; the body carries the current settings. */
  "settings_conflict",
  /** MAX_LIVE_MESSAGES, or this member's MAX_UNOPENED_PER_MEMBER, already. */
  "message_limit",
  "rate_limited",
  "unavailable",
  /** Asking for help with no approved caretaker phone in the circle: nobody was told. */
  "no_caretaker",
  /** Answering a help request that is already closed; the body carries it as it stands. */
  "help_closed",
]);
export type CircleErrorCode = z.infer<typeof CircleErrorCodeSchema>;

export const CIRCLE_ERROR_STATUS: Record<CircleErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  not_allowed: 403,
  not_found: 404,
  invite_code_invalid: 400,
  invite_locked: 429,
  circle_full: 409,
  walker_offline: 409,
  suggestion_waiting: 409,
  unchanged: 409,
  item_closed: 409,
  settings_conflict: 409,
  message_limit: 409,
  rate_limited: 429,
  unavailable: 503,
  no_caretaker: 409,
  help_closed: 409,
};

export const CircleErrorSchema = z.strictObject({
  error: z.strictObject({
    code: CircleErrorCodeSchema,
    message: z.string(),
    trace_id: z.string(),
    /** `item_closed`, on the walker's own routes only. */
    item: CircleItemSchema.optional(),
    /** `suggestion_waiting`, to the member: their waiting suggestion, as a projection. */
    suggestion: MemberSuggestionViewSchema.optional(),
    /** `settings_conflict`, on the walker's own routes only. */
    settings: ScreenSettingsSchema.optional(),
    /** `help_closed`: the help request as it stands. */
    help: HelpViewSchema.optional(),
  }),
});
export type CircleError = z.infer<typeof CircleErrorSchema>;

// ---- The walker screen's local contract (Pi -> page on 127.0.0.1) ----
//
// The Pi decides which state shows; the page draws it and decides nothing. The page gets `ScreenState` as the
// `data:` of each `state` event on GET /screen/events, and posts `ScreenShown` and `ScreenPress` back. Every
// request carries the Pi's per-boot screen token (embedded in the page it serves), and the Pi checks Host and
// Origin, because any page in a browser on the same machine can reach 127.0.0.1.

/** The Pi's link to the server, as the status strip shows it. */
export const ScreenLinkSchema = z.enum(["unpaired", "connecting", "online", "offline", "unauthorized"]);
export type ScreenLink = z.infer<typeof ScreenLinkSchema>;

export const StatusStripSchema = z.strictObject({
  link: ScreenLinkSchema,
  /** The whole walker is the simulator: the strip shows a dashed "Simulator". */
  simulator: z.boolean(),
  /**
   * The Pi's motion coordinator runs in bench mode (motion.ts, MOTION_BENCH_ENV): the arms and lift may move
   * with no hardware stop. The strip shows a dashed "Bench mode" on every screen, and every motion screen
   * says BENCH_MODE_LABEL in full. False when there is no motion coordinator. Added 2026-10-24.
   */
  bench_mode: z.boolean(),
  /** The walker's local wall time, no offset; null when its clock has never synced (no time is shown). */
  clock: z
    .strictObject({ local_time: z.iso.datetime({ local: true }).regex(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/, "Local time, no offset.") })
    .nullable(),
});
export type StatusStrip = z.infer<typeof StatusStripSchema>;

/** Where a reply came from, in small type: the model, the server's fixed line, or the walker's own offline line. */
export const ReplySourceSchema = z.enum(["model", "fixed", "walker"]);

const minutesLeft = z.int().min(0).max(Math.ceil(CIRCLE_ITEM_TTL_MS / 60_000));
export const MyScreenViewSchema = z.discriminatedUnion("page", [
  z.strictObject({ page: z.literal("menu") }),
  z.strictObject({ page: z.literal("text_size") }),
  /** Captions, and reading messages aloud automatically. */
  z.strictObject({ page: z.literal("reading") }),
  /**
   * Her circle, one person per screen. Index 0 is the owner (who can read her conversations, and can't be
   * removed here); 1..count-1 are the members, in `members` order.
   */
  z
    .strictObject({
      page: z.literal("circle"),
      index: z.int().min(0),
      owner_name: CircleNameSchema.nullable(),
      member: CircleMemberSchema.nullable(),
      count: z.int().min(1).max(MAX_CIRCLE_MEMBERS + 1),
      /** "Remove Cooper?": the first tap asked, the next tap removes. */
      confirm_remove: z.boolean(),
    })
    .refine((p) => p.index < p.count && (p.index === 0) === (p.member === null) && (!p.confirm_remove || p.member !== null), {
      message: "Index 0 is the owner; members follow.",
      path: ["index"],
    }),
]);

// ---- Motion on the walker screen (added 2026-10-24) ----
//
// The motion coordinator (devices/pi/src/motion/, motion.ts's MotionState) decides everything; these states
// only carry what the screen draws. The screen never starts motion: a Confirm target is answered only by a
// handle Confirm press, so a motion screen has no touch Confirm. Its one touch control is the lift's hold
// control, shown only while a hold-to-run lift target is pending or running (`holdControlShown`).

/** A Pi-worded title (a skill's, pose's or action's, from the Pi's own files or fixed words; never cloud text). */
const MotionTitleSchema = z.string().trim().min(1).max(60);

/** Which way the held lift goes, as the hold control says it: "Hold to raise", "Hold to lower", "Hold to home", "Hold to move". */
export const ScreenHoldDirectionSchema = z.enum(["raise", "lower", "home", "move"]);
export type ScreenHoldDirection = z.infer<typeof ScreenHoldDirectionSchema>;

/** A pending Confirm target as the screen shows it: the Pi's own title and the prompt it says (ConfirmTarget). */
const ScreenConfirmTargetSchema = z
  .strictObject({
    target_id: id,
    title: MotionTitleSchema,
    /** ConfirmTarget.prompt, word for word: the title, then PARK_PROMPT or CONFIRM_ONLY_PROMPT. */
    prompt: z.string().min(1).max(160),
  })
  .refine((t) => t.prompt === confirmPrompt(t.title, true) || t.prompt === confirmPrompt(t.title, false), {
    message: "prompt is confirmPrompt(title).",
    path: ["prompt"],
  });

const motionStates = [
  /**
   * The one pending Confirm target, while nothing moves and no fault is latched: "Bring the cup? Park the
   * walker and lock the brakes, then press Confirm." `hold` is set exactly for a hold-to-run lift target
   * (lift.home, lift.move): the screen shows the hold control, which must be held while Confirm is pressed.
   */
  z.strictObject({
    state: z.literal("motion_confirm"),
    target: ScreenConfirmTargetSchema,
    hold: ScreenHoldDirectionSchema.nullable(),
  }),
  /**
   * Something is moving (or teleop is on). `what` is the Pi's words for it ("Bring the cup", "Raising the
   * lift"). Any handle button stops it. `lift` is set for a lift motion: `running` while the hold control
   * holds it (the screen says "Keep holding"), `stopping` while it ramps down after a release or a stop (it
   * never resumes, so the hold control goes).
   */
  z.strictObject({
    state: z.literal("motion_running"),
    what: MotionTitleSchema,
    lift: z.strictObject({ phase: z.enum(["running", "stopping"]), direction: ScreenHoldDirectionSchema }).nullable(),
  }),
  /**
   * A few seconds after a motion ended with no fault: it finished (`completed`), was stopped (`stopped`), or
   * the press didn't start it (`not_started`, with the refusal; the screen shows REFUSAL_SENTENCES[refusal]).
   * The arms and lift hold where they are in every case.
   */
  z
    .strictObject({
      state: z.literal("motion_holding"),
      outcome: z.enum(["completed", "stopped", "not_started"]),
      refusal: MotionRefusalSchema.nullable(),
    })
    .refine((h) => (h.outcome === "not_started") === (h.refusal !== null), {
      message: "A refusal is named exactly when it didn't start.",
      path: ["refusal"],
    }),
  /**
   * Motion faults are latched (MotionState mode `fault`): every code, oldest first. The screen shows the first
   * one's FAULT_SENTENCES sentence and FAULT_CLEAR_SENTENCE, and how many more. `confirm` is a pending target
   * allowed while faulted (clearing the faults, or making the hardware safer), shown with the fault.
   */
  z
    .strictObject({
      state: z.literal("motion_fault"),
      faults: z.array(MotionFaultCodeSchema).min(1).max(MotionFaultCodeSchema.options.length),
      confirm: ScreenConfirmTargetSchema.nullable(),
    })
    .refine((f) => new Set(f.faults).size === f.faults.length, { message: "Each fault appears once.", path: ["faults"] }),
] as const;

// ---- Walking directions on the walker screen (added 2026-10-24, docs/subsystems/navigation.md) ----
//
// The Pi's Navigator decides everything: the words, the distances and the map's points. The screen only draws
// them. The coordinates stay on the Pi: this contract is served on 127.0.0.1 only, never sent to the server.

/** [latitude, longitude] in degrees. */
export const LatLonSchema = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
export type LatLon = z.infer<typeof LatLonSchema>;

/** At most this many route points go to the screen: the route ahead of her, thinned by the Pi. */
export const NAVIGATION_MAP_POINTS = 200;

export const NavigatingScreenSchema = z.strictObject({
  state: z.literal("navigating"),
  destination: PlaceNameSchema,
  phase: NavigationPhaseSchema,
  /** The whole sentence, for a screen reader and the long form ("Turn left onto Lenox Avenue."). */
  instruction: InstructionSchema,
  /** The short form the screen draws large: an arrow and a word ("Left"), with the street under it. */
  maneuver: ManeuverSchema,
  /** The street or path name to turn onto; null when the way has no name ("the path" in speech). */
  street: z.string().trim().min(1).max(60).nullable(),
  /** Metres to that instruction's point, rounded to 10 by the Pi; null when there is no position. */
  to_step_m: z.int().min(0).max(100_000).nullable(),
  remaining_m: z.int().min(0).max(100_000),
  remaining_min: z.int().min(0).max(1_000),
  /** The position is the simulated one (`walker simulate`, or WALKER_GPS_SIMULATED on the Pi): a dashed Simulated tag. */
  simulated: z.boolean(),
  map: z.strictObject({
    /** Her position; null when there is none (phase `no_position` before any fix). */
    position: LatLonSchema.nullable(),
    /** The route ahead of her, from her snapped position to the end. */
    route: z.array(LatLonSchema).min(2).max(NAVIGATION_MAP_POINTS),
    /** The next instruction's point; null when the next thing is arriving. */
    step_at: LatLonSchema.nullable(),
    destination_at: LatLonSchema,
  }),
});
export type NavigatingScreen = z.infer<typeof NavigatingScreenSchema>;
// ---- Cards Sophi pulls up (`show_on_screen`, added 2026-10-24, docs/subsystems/show-on-screen.md) ----
//
// The model names a view (ShowViewSchema in walker.ts); the Pi fills the card from its own data and the screen
// draws it. No field here holds words the model wrote. Coordinates never appear: the card carries the address
// and the weather, not the position.

const cardLine = (max: number) => z.string().trim().min(1).max(max).regex(oneLine, "One line, no control characters.");

export const ShowCardSchema = z.discriminatedUnion("view", [
  z.strictObject({
    view: z.literal("weather"),
    /** Whole degrees Fahrenheit, as Open-Meteo reported them near her. */
    temperature_f: z.int().min(-150).max(150),
    /** The Pi's words for the weather code ("partly cloudy skies"). */
    conditions: cardLine(40),
    wind_mph: z.int().min(0).max(300),
    /**
     * The simulator's sample weather (`walker simulate --gps`), not Open-Meteo's: the card says so and credits no
     * provider. (A simulated position with real weather would need its own flag.)
     */
    simulated: z.boolean(),
  }),
  z.strictObject({
    view: z.literal("location"),
    /** The reverse geocoder's nearest address, cleaned on the Pi ("600 Bellevue Avenue, Oakland"). */
    place: cardLine(120),
    simulated: z.boolean(),
  }),
  z.strictObject({
    view: z.literal("sensors"),
    /** Every zone the walker reports, kept current by the Pi while the card is up. Unknown is never clear. */
    zones: z
      .array(
        z.strictObject({
          zone: ZoneNameSchema,
          distance: z.discriminatedUnion("status", [
            z.strictObject({ status: z.literal("measured"), mm: ZoneDistanceSchema }),
            z.strictObject({ status: z.literal("unknown") }),
          ]),
          simulated: z.boolean(),
        }),
      )
      .min(1)
      .max(16),
  }),
  z.strictObject({
    view: z.literal("message"),
    message_id: z.uuid(),
    from_name: CircleNameSchema,
    text: CircleMessageSchema.shape.text,
  }),
  z.strictObject({
    view: z.literal("parts"),
    parts: z.array(z.strictObject({ module_id: ModuleIdSchema, health: ModuleHealthSchema, simulated: z.boolean() })).min(1).max(16),
  }),
  z.strictObject({ view: z.literal("companion"), code: CircleInviteSchema.shape.code }),
]);
export type ShowCard = z.infer<typeof ShowCardSchema>;

// ---- Asking for help on the walker screen (added 2026-10-24, docs/subsystems/help.md) ----
//
// The Pi decides; the screen draws. Help needs no touch control: the handles start it, stop a countdown and
// say "I'm okay", so there is no ScreenAction for it (her phone is the touch path). Calm words only, as everywhere
// on this screen. While help_hold, help_countdown or an open request shows, help owns Confirm: a pending motion
// target, a model offer and a message draft are not answered by it (docs/subsystems/help.md, "Confirm during help").

const helpStates = [
  /** Both handle buttons are down and HELP_HOLD_MS hasn't passed: "Keep holding to ask for help." Letting go sends nothing. */
  z.strictObject({ state: z.literal("help_hold") }),
  /** A voice request, counting down: "Asking for help in 8 seconds." "Press any button to stop." */
  z.strictObject({ state: z.literal("help_countdown"), seconds_left: z.int().min(1).max(Math.ceil(HELP_COUNTDOWN_MS / 1_000)) }),
  z.strictObject({
    state: z.literal("help"),
    help: z.discriminatedUnion("phase", [
      /** Sent and not yet answered by the server. `retrying`: the last try failed ("No internet yet. Still trying."). */
      z.strictObject({ phase: z.literal("sending"), retrying: z.boolean() }),
      /**
       * Nothing was sent. `no_caretaker`: no caretaker phone is linked. `offline`: HELP_SEND_RETRY_MS of tries
       * failed. `failed`: the server refused it for another reason.
       */
      z.strictObject({ phase: z.literal("not_sent"), why: z.enum(["no_caretaker", "offline", "failed"]) }),
      /**
       * The server has it: "Sent to Maya's phone.", then "It's showing on Maya's phone.", then "Maya is on the way."
       * `confirm_okay`: her first Confirm armed it ("Press Confirm again to tell Maya you're okay.").
       */
      z.strictObject({
        phase: z.literal("open"),
        /** Names only: the screen never needs member ids. */
        sent_to: z.array(CircleNameSchema).min(1).max(MAX_CIRCLE_MEMBERS),
        shown_to: z.array(CircleNameSchema).max(MAX_CIRCLE_MEMBERS),
        coming: z.array(CircleNameSchema).max(MAX_CIRCLE_MEMBERS),
        confirm_okay: z.boolean(),
      }),
      /** Closed, shown for a while: her okay ("Okay. Maya will see that you're okay."), a caretaker with her (named), or that it ended. */
      z.strictObject({
        phase: z.literal("closed"),
        how: HelpClosedHowSchema,
        by_name: CircleNameSchema.nullable(),
        sent_to: z.array(CircleNameSchema).min(1).max(MAX_CIRCLE_MEMBERS),
      }),
    ]),
  }),
] as const;

/**
 * The one thing on screen, in the Pi's priority order: an obstacle first; then a running motion or a latched
 * motion fault; then her own Talk (listening, thinking, answering); then asking for help (`help_hold`,
 * `help_countdown`, `help`, added 2026-10-24: while a request is open it stays under her Talk, above everything
 * below); then a card Sophi pulled up (`showing`, added 2026-10-24: over her Talk's thinking and answering, with
 * the answer captioned on it, but never over help); then a pending motion Confirm target; then
 * today's model offer (it keeps the screen, and Confirm, until settled); then a circle item; then a message
 * notice; then a route in progress (`navigating`, which also stands above `offline`: guidance runs on the Pi);
 * then the clock. (The motion states and their place, added 2026-10-24, are explained in the Pi's
 * `pickScreen`.) An offer that arrives by heartbeat (typed on the owner's page) while a circle item is on screen
 * waits behind it; only an offer from her own Talk turn takes over. Confirm during an obstacle settles
 * nothing. An interruption returns to the screen she was on, with a new revision (the item's gate starts again).
 */
export const ScreenContentSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("obstacle"),
    zone: ZoneNameSchema,
    distance: z.discriminatedUnion("status", [
      z.strictObject({ status: z.literal("measured"), mm: ZoneDistanceSchema }),
      z.strictObject({ status: z.literal("unknown") }),
    ]),
    /** The reading came from a simulated sensor. */
    simulated: z.boolean(),
  }),
  z.strictObject({ state: z.literal("listening") }),
  /**
   * A card Sophi pulled up for her own question. It sits under `listening` and over `thinking` and `answering`
   * (but never over help: see the order below), so the card stays up while Sophi says it's there; `caption` carries the answer's current caption page then
   * (null when none is playing, or captions are off), so captions never vanish under a card.
   */
  z.strictObject({ state: z.literal("showing"), card: ShowCardSchema, caption: z.string().min(1).max(600).nullable() }),
  /** Her Talk turn is with Sophi: Talk was let go and no answer has come yet ("One moment"). Added 2026-10-24. */
  z.strictObject({ state: z.literal("thinking") }),
  z.strictObject({
    state: z.literal("answering"),
    /** What the walker heard her say; null when nothing was transcribed. */
    heard: z.string().max(1000).nullable(),
    reply: z.string().min(1).max(600),
    source: ReplySourceSchema,
    /** Which caption page shows (0-based). The Pi pages with `captionPages` from @walker/walker-screen. */
    page: z.int().min(0),
  }),
  z.strictObject({
    state: z.literal("model_offer"),
    proposal_id: id,
    from_cues: CueListSchema,
    cues: CueListSchema,
  }),
  z.strictObject({
    state: z.literal("suggestion"),
    item_id: id,
    from_name: CircleNameSchema,
    change: SuggestionChangeSchema,
    minutes_left: minutesLeft,
    /** She pressed before the gate opened: "One moment". */
    one_moment: z.boolean(),
  }),
  z.strictObject({
    state: z.literal("member_join"),
    item_id: id,
    name: CircleNameSchema,
    role: CircleRoleSchema,
    invited_by_name: CircleNameSchema,
    /** `again`: the first press armed it; "Press Confirm again to let Cooper in." (its own revision and gate). */
    step: z.enum(["first", "again"]),
    minutes_left: minutesLeft,
    one_moment: z.boolean(),
  }),
  z
    .strictObject({
      state: z.literal("done"),
      result: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("change"), change: SuggestionChangeSchema }),
        z.strictObject({ kind: z.literal("alerts"), cues: CueListSchema }),
        z.strictObject({ kind: z.literal("joined"), name: CircleNameSchema }),
        z.strictObject({ kind: z.literal("removed"), name: CircleNameSchema }),
        z.strictObject({ kind: z.literal("nothing_changed") }),
      ]),
      /** "Change it back" is offered (for CHANGE_BACK_MS after a change). */
      change_back: z.boolean(),
    })
    .refine((d) => !d.change_back || d.result.kind === "change", { message: "Only a change can be changed back.", path: ["change_back"] }),
  z.strictObject({
    state: z.literal("message_waiting"),
    message_id: id,
    from_name: CircleNameSchema,
    /** Other unopened messages after this one. */
    more: z.int().min(0).max(MAX_LIVE_MESSAGES),
  }),
  z.strictObject({
    state: z.literal("message"),
    message_id: id,
    from_name: CircleNameSchema,
    text: CircleMessageSchema.shape.text,
  }),
  NavigatingScreenSchema,
  z.strictObject({ state: z.literal("offline") }),
  z.strictObject({ state: z.literal("not_set_up") }),
  z.strictObject({
    state: z.literal("ambient"),
    /** The alerts in force; null before the walker has a configuration. */
    alerts: CueListSchema.nullable(),
    companion_code: CircleInviteSchema.shape.code.nullable().optional(),
  }),
  z.strictObject({ state: z.literal("my_screen"), view: MyScreenViewSchema }),
  ...motionStates,
  ...helpStates,
]);
export type ScreenContent = z.infer<typeof ScreenContentSchema>;

/**
 * Which way the lift's hold control on this screen goes, or null when the screen doesn't show one. It shows
 * exactly while a hold-to-run lift target is pending, or its lift motion runs held. The page draws the
 * control from this, and the Pi's screen server takes a "still held" only while the state it last sent shows it.
 */
export function holdControlShown(content: ScreenContent): ScreenHoldDirection | null {
  if (content.state === "motion_confirm") return content.hold;
  if (content.state === "motion_running" && content.lift?.phase === "running") return content.lift.direction;
  return null;
}
export type ScreenStateName = ScreenContent["state"];

/**
 * Her settings as the walker applies them now. `version` is the server version they are built on; with
 * `pending_local`, a change of hers (made on My screen, maybe offline) sits on top of it and hasn't reached the
 * server yet, so the choices here are not that version's.
 */
export const AppliedScreenSettingsSchema = z.strictObject({
  ...ScreenSettingsSchema.shape,
  pending_local: z.boolean(),
});
export type AppliedScreenSettings = z.infer<typeof AppliedScreenSettingsSchema>;

export const ScreenStateSchema = z.strictObject({
  v: z.literal(1),
  /** Goes up by one with every state the Pi sends since it started; presses and "shown" name it. */
  revision: z.int().min(0),
  screen: ScreenContentSchema,
  settings: AppliedScreenSettingsSchema,
  strip: StatusStripSchema,
});
export type ScreenState = z.infer<typeof ScreenStateSchema>;

/**
 * POST /screen/shown: the page has drawn this revision. `item_id` is the circle item on it (null for none),
 * so the Pi can tell the item's own gate from a stale report. The Pi forgets it when an obstacle or Talk
 * interrupts, and the item's gate starts again from the new revision. The settings fields echo what was
 * drawn; the Pi reports `settings_version_drawn` to the server only when `settings_pending_local` is false.
 */
export const ScreenShownSchema = z.strictObject({
  revision: z.int().min(0),
  item_id: id.nullable(),
  settings_version: z.int().positive(),
  settings_pending_local: z.boolean(),
});
export type ScreenShown = z.infer<typeof ScreenShownSchema>;

/**
 * The large buttons. `confirm` is the touch twin of the left handle and goes through the same Pi checks.
 * `not_now` lets a suggestion or join go (the Pi answers it `ignore`); on the handles, doing nothing for its
 * 5 minutes does the same, and Talk never dismisses it.
 */
export const ScreenActionSchema = z.enum([
  "confirm",
  "not_now",
  "read_message",
  "change_back",
  "my_screen",
  "text_size",
  "reading",
  "circle",
  "text_bigger",
  "text_smaller",
  "toggle_captions",
  "toggle_read_aloud",
  "next",
  "remove",
  "keep",
  "done",
  /** On `navigating`: end the route, like "Stop the directions". */
  "end_route",
  /** On `navigating`: say the next instruction again, like a Confirm press with nothing to confirm. */
  "repeat_direction",
]);
export type ScreenAction = z.infer<typeof ScreenActionSchema>;

/** POST /screen/press: a tap on a button of this revision. The Pi ignores a press on an older revision. */
export const ScreenPressSchema = z.strictObject({ revision: z.int().min(0), action: ScreenActionSchema });
export type ScreenPress = z.infer<typeof ScreenPressSchema>;

/**
 * POST /screen/hold: the lift's hold control (motion.ts, HoldSourceSchema `screen_hold_control`). While her
 * finger is on it, the page sends `pressed: true` more often than HOLD_CONTROL_REFRESH_MS; any of
 * SCREEN_HOLD_RELEASE_EVENTS, the control going, or the page losing its stream sends `pressed: false`.
 * `at` is the page's own clock (`performance.timeOrigin + performance.now()`, ms). The Pi never uses it for
 * freshness: it stamps every message with its monotonic clock on receipt. `at` only orders one page's
 * messages, so a "still held" that a release overtook on the way is dropped. Added 2026-10-24.
 */
export const ScreenHoldSchema = z.strictObject({ pressed: z.boolean(), at: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER) });
export type ScreenHold = z.infer<typeof ScreenHoldSchema>;
