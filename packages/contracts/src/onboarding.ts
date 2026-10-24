import { z } from "zod";
import { ModuleIdSchema } from "./catalog";

/**
 * Onboarding session API, version 1. Wire format is snake_case JSON.
 * See docs/interfaces.md ("Cloud API surface") for the routes that carry these shapes.
 */

export const ONBOARDING_API_VERSION = 1;

/**
 * What a user's words were taken to mean. Tags describe tasks and preferences, never a condition or
 * diagnosis, and every tag shown to the user can be corrected by editing or removing the fact behind it.
 */
export const NeedTagSchema = z.enum([
  "notice_obstacles",
  "pick_up",
  "reach_high",
  "reach_low",
  "heavy_items",
  "easy_controls",
  "button_left",
  "button_right",
  "speak_requests",
  "app_requests",
  "vibration_feedback",
  "spoken_feedback",
  "sound_feedback",
  "screen_feedback",
  "home",
  "outdoors",
  "public_places",
  "location_sharing",
  "walker_only",
]);
export type NeedTag = z.infer<typeof NeedTagSchema>;

export const NEED_TAG_LABELS: Record<NeedTag, string> = {
  notice_obstacles: "knowing when something is in the way",
  pick_up: "picking things up",
  reach_high: "reaching high shelves",
  reach_low: "reaching low or from the floor",
  heavy_items: "lifting heavier things",
  easy_controls: "large, easy controls",
  button_left: "a button on the left handle",
  button_right: "a button on the right handle",
  speak_requests: "asking out loud",
  app_requests: "typing in the app",
  vibration_feedback: "vibration in the handles",
  spoken_feedback: "spoken messages",
  sound_feedback: "short sounds",
  screen_feedback: "text on a screen",
  home: "using it at home",
  outdoors: "using it outside",
  public_places: "using it in shops and public buildings",
  location_sharing: "sharing the walker's location",
  walker_only: "starting with just the walker",
};

export const QuestionIdSchema = z.enum([
  "tasks",
  "places",
  "feedback",
  "start_request",
  "reach_detail",
  "location",
  "anything_else",
]);
export type QuestionId = z.infer<typeof QuestionIdSchema>;

export const QuestionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const QuestionSchema = z.object({
  id: QuestionIdSchema,
  /** Short enough to set large: two lines at most on a phone. */
  prompt: z.string().min(1).max(48),
  detail: z.string().min(1),
  selection: z.enum(["single", "multiple"]),
  options: z.array(QuestionOptionSchema),
  text_label: z.string().min(1),
});
export type Question = z.infer<typeof QuestionSchema>;

export const ProfileFactSchema = z.object({
  id: z.string().min(1),
  question_id: QuestionIdSchema,
  text: z.string().min(1),
  /** chosen: an option label; typed: the user's own words; edited: the user rewrote it during review. */
  source: z.enum(["chosen", "typed", "edited"]),
  /** What the engine took the fact to mean. An inference, shown as one. */
  tags: z.array(NeedTagSchema),
  /** Things the user said they do not want ("I don't want to talk to it"). */
  declined_tags: z.array(NeedTagSchema),
});
export type ProfileFact = z.infer<typeof ProfileFactSchema>;

export const RecommendationStatusSchema = z.enum([
  "required",
  "recommended",
  "consider",
  "not_suggested",
  "unavailable",
]);
export type RecommendationStatus = z.infer<typeof RecommendationStatusSchema>;

export const RecommendationSchema = z.object({
  module_id: ModuleIdSchema,
  status: RecommendationStatusSchema,
  /** Each reason points at the fact it came from, so the UI can quote the user's own words. */
  reasons: z.array(z.object({ text: z.string().min(1), fact_id: z.string().nullable() })),
  /** Caveats specific to what this user said (the catalog's general limitations are separate). */
  notes: z.array(z.string().min(1)),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const TurnSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["assistant", "user"]),
  text: z.string().min(1),
  question_id: QuestionIdSchema.nullable(),
  created_at: z.iso.datetime(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const SessionStateSchema = z.enum(["collecting", "review", "confirmed", "expired"]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const DeviceConfigurationSchema = z.object({
  configuration_version: z.number().int().positive(),
  catalog_version: z.number().int().positive(),
  selected_module_ids: z.array(ModuleIdSchema),
  preferences: z.object({
    cues: z.array(z.enum(["vibration", "spoken", "sound", "screen"])),
    request_start: z.array(z.enum(["left_button", "right_button", "voice", "app"])),
  }),
  confirmed_at: z.iso.datetime(),
  /** Where it was saved. Demo configurations can't be paired with a real walker. */
  source: z.enum(["demo", "account"]),
});
export type DeviceConfiguration = z.infer<typeof DeviceConfigurationSchema>;

export const SessionKindSchema = z.enum(["demo", "account"]);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const SessionViewSchema = z.object({
  session_id: z.string().min(1),
  /** demo: anonymous and deleted an hour after the last change. account: owned by the signed-in user. */
  kind: SessionKindSchema,
  state: SessionStateSchema,
  revision: z.number().int().nonnegative(),
  catalog_version: z.number().int().positive(),
  input_mode: z.literal("text"),
  created_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  current_question: QuestionSchema.nullable(),
  /** The earlier answer to the current question, when the user went back to change it. */
  current_answer: z.object({ option_ids: z.array(z.string()), text: z.string().nullable() }).nullable(),
  progress: z.object({ answered: z.number().int().nonnegative(), total: z.number().int().positive() }),
  turns: z.array(TurnSchema),
  facts: z.array(ProfileFactSchema),
  recommendations: z.array(RecommendationSchema),
  configuration: DeviceConfigurationSchema.nullable(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

// ---- Requests ----

export const StartSessionRequestSchema = z.object({
  input_mode: z.literal("text"),
  /**
   * Which data notice the user read on the start screen. It also picks the kind of session, so a
   * session is never kept longer than the notice said, even if the user signed in or out meanwhile.
   */
  consent: z.union([
    z.object({
      /**
       * A demo session: answers are kept for an hour after the last change and then deleted, and, when
       * the onboarding agent is on, they are also sent to the model provider.
       */
      demo_data_notice: z.literal(true),
    }),
    z.object({
      /**
       * An account session (needs a signed-in user): answers and the saved setup are kept in the user's
       * account until they delete them; an unfinished setup is deleted 30 days after the last change.
       * The same model-provider notice applies when the agent is on.
       */
      account_data_notice: z.literal(true),
    }),
  ]),
});
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;

const MAX_TEXT = 600;

export const TurnInputSchema = z.discriminatedUnion("type", [
  /** Free text answering the current question. */
  z.object({ type: z.literal("text"), text: z.string().trim().min(1).max(MAX_TEXT) }),
  /** Chosen options, optionally with the user's own words, for a named question. */
  z
    .object({
      type: z.literal("answer"),
      question_id: QuestionIdSchema,
      option_ids: z.array(z.string().min(1)).max(8),
      text: z.string().trim().max(MAX_TEXT).optional(),
    })
    .refine((a) => a.option_ids.length > 0 || (a.text ?? "").length > 0, {
      message: "Choose an option or write an answer.",
    }),
  z.object({ type: z.literal("skip"), question_id: QuestionIdSchema }),
  /** Skip every remaining question and go to review. */
  z.object({ type: z.literal("skip_rest") }),
  /** Ask an earlier question again; its new answer replaces the old one. */
  z.object({ type: z.literal("revisit"), question_id: QuestionIdSchema }),
]);
export type TurnInput = z.infer<typeof TurnInputSchema>;

export const TurnRequestSchema = z.object({
  client_turn_id: z.uuid(),
  last_seen_revision: z.number().int().nonnegative(),
  input: TurnInputSchema,
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

export const TurnResponseSchema = z.object({
  session: SessionViewSchema,
  /** Everything the assistant said this turn: the acknowledgement plus the next question. */
  assistant_text: z.string().min(1),
  /** Just the acknowledgement ("Good to know: at home."), the part of assistant_text before the next question. */
  ack: z.string().nullable(),
  needs_user_confirmation: z.boolean(),
});
export type TurnResponse = z.infer<typeof TurnResponseSchema>;

export const ProfileEditRequestSchema = z.object({
  last_seen_revision: z.number().int().nonnegative(),
  edit: z.discriminatedUnion("type", [
    z.object({ type: z.literal("update"), fact_id: z.string().min(1), text: z.string().trim().min(1).max(MAX_TEXT) }),
    z.object({ type: z.literal("remove"), fact_id: z.string().min(1) }),
  ]),
});
export type ProfileEditRequest = z.infer<typeof ProfileEditRequestSchema>;

export const ConfirmRequestSchema = z.object({
  last_seen_revision: z.number().int().nonnegative(),
  selected_module_ids: z.array(ModuleIdSchema).min(1),
});
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>;

export const SessionResponseSchema = z.object({ session: SessionViewSchema });
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

// ---- Errors ----

export const ApiErrorCodeSchema = z.enum([
  "invalid_request",
  "unauthenticated",
  "not_found",
  "revision_conflict",
  "session_expired",
  "session_confirmed",
  "question_mismatch",
  "invalid_selection",
  "rate_limited",
  /** 503: the server can't take this request now, for example because it has no database configured. */
  "unavailable",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    trace_id: z.string(),
    /** On a revision conflict, the current state so the UI can recover without a reload. */
    session: SessionViewSchema.optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
