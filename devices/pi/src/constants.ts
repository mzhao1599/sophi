import { HEARTBEAT_INTERVAL_MS as CONTRACT_HEARTBEAT_INTERVAL_MS, VOICE_CLIP_MAX_MS } from "@walker/contracts";

/**
 * Every timing and threshold the Pi service uses, in one place.
 *
 * "Placeholder, not measured" means a number chosen to make the prototype behave sensibly, not a value
 * from a bench test. Replace each one after measuring it on the walker, and record the measurement in
 * hardware/current-build.md. None of them is a safety claim: obstacle cues are advisory proximity cues,
 * not collision avoidance.
 */

// ---- Serial modules ----

/** Placeholder, not measured: no heartbeat (or hello) for this long marks a module `unavailable`. */
export const MODULE_HEARTBEAT_TIMEOUT_MS = 3000;
/** Placeholder, not measured: on one port, the Pi sends at most one `hello.request` this often (only as lines arrive). */
export const HELLO_REQUEST_MIN_GAP_MS = 2000;
/** Placeholder, not measured: how often the Pi looks for newly plugged-in serial modules. */
export const SERIAL_RESCAN_MS = 5000;
/** Assumption: the ESP32 boards' USB serial bridges run at 115200 baud (to confirm with the firmware). */
export const SERIAL_BAUD = 115200;

// ---- Obstacle cues ----

/** Placeholder, not measured: a ToF reading counts for this long after the Pi receives it. */
export const ZONE_VALIDITY_MS = 500;
/** Placeholder, not measured: a zone becomes "near" under this distance. */
export const NEAR_ENTER_MM = 750;
/** Placeholder, not measured: a near zone clears only over this distance (hysteresis). */
export const NEAR_EXIT_MM = 900;
/** Placeholder, not measured: while a zone stays near, its cue repeats at most this often. */
export const CUE_REPEAT_MS = 3000;
/** Placeholder, not measured: a newly near zone cues at most this often, across all zones. */
export const CUE_MIN_GAP_MS = 1000;
/** Placeholder, not bench-tested: length of the near_obstacle haptic pattern (the interface doc's example). */
export const OBSTACLE_HAPTIC_MS = 400;
/**
 * Placeholder, not bench-tested: the buzz a Talk press gives on the hand that pressed it (`recording`).
 * Button feedback, not an obstacle alert; see `pressBuzz` in service.ts.
 */
export const TALK_PRESS_HAPTIC_MS = 300;
/** Placeholder: the buzz a Confirm press gives on its hand (`confirmation` or `error`); long enough for two or three strong buzzes. */
export const CONFIRM_PRESS_HAPTIC_MS = 700;

// ---- Buttons ----

/** Placeholder, not measured: gpiomon must stay up this long before the GPIO buttons count as watched. */
export const GPIOMON_SETTLE_MS = 1000;
/** Placeholder, not measured: a GPIO button must hold a level this long before the Pi believes it. */
export const GPIO_DEBOUNCE_MS = 30;
/** Prototype: keep an ESP32 Talk recording open through a brief release and re-press. Adds this much send delay. */
export const ESP32_TALK_RELEASE_GRACE_MS = 900;

// ---- Voice clips (from the walker contract: at most 15 s, 16 kHz mono 16-bit WAV, at most 1 MB) ----

export const CLIP_SAMPLE_RATE = 16000;
export const CLIP_MAX_MS = VOICE_CLIP_MAX_MS;
export const CLIP_BYTES_PER_MS = (CLIP_SAMPLE_RATE * 2) / 1000;
export const CLIP_MAX_PCM_BYTES = CLIP_MAX_MS * CLIP_BYTES_PER_MS;
/** Placeholder, not measured: a shorter press is treated as accidental and nothing is sent. */
export const CLIP_MIN_MS = 300;
/** Placeholder: a spoken line still playing after this is stopped (the server's longest reply is about a minute). */
export const SPEECH_LINE_MAX_MS = 90_000;
/** Placeholder: a cue sound's player still running after this is killed. */
export const CUE_PLAYER_MAX_MS = 2000;

/** Placeholder: the same local line said again within this long is spoken but not sent to the page again. */
export const LOCAL_LINE_REPEAT_MS = 30_000;

// ---- The walker screen (src/screen/) ----

/** The screen page's port on 127.0.0.1 (WALKER_SCREEN_PORT changes it). A choice, not a standard port. */
export const SCREEN_DEFAULT_PORT = 8740;
/** Placeholder, not measured: "Done" or "Nothing changed" stays this long after a Confirm settles an offer. */
export const SCREEN_DONE_MS = 4000;
/** Placeholder, not measured: captions stay this long after the reply finishes (none while an offer waits for Confirm). */
export const SCREEN_ANSWER_HOLD_MS = 3000;
/** A caretaker's message stays on the screen this long after it was read aloud (it can be heard again on Confirm). */
export const SCREEN_MESSAGE_HOLD_MS = 20_000;
/** Placeholder, not measured: speaking rate used to turn caption pages (Piper and Cartesia both sound near this). */
export const CAPTION_CHARS_PER_S = 15;
/** Placeholder, not measured: the shortest time a caption page shows. */
export const CAPTION_PAGE_MIN_MS = 2500;
/** Placeholder, not measured: "Something close" stays this long after the last near reading, so a pass is readable. */
export const SCREEN_OBSTACLE_TAIL_MS = 1000;
/** Placeholder: zones arrive at the sensor's rate; the screen redraws a changed distance at most this often. */
export const SCREEN_ZONES_MIN_MS = 250;
/**
 * Placeholder: the motion coordinator publishes its state at least every 200 ms (MOTION_STATE_PUBLISH_MS) while it
 * runs. A state older than this is stale: the screen drops every motion screen and the hold control rather than
 * show a motion it can no longer see (the lift stops by itself when the coordinator's heartbeats stop).
 */
export const SCREEN_MOTION_STALE_MS = 1000;

// ---- Walking directions (src/navigation/; docs/subsystems/navigation.md) ----
// The guide's numbers, chosen for a walker on a sidewalk; none is measured on a real walk yet.

/** Placeholder: at most one Nominatim request this often (the public service's limit is one a second). */
export const NOMINATIM_GAP_MS = 1_100;
/** Placeholder: one map request (search, reverse, route) gives up after this long. */
export const MAP_REQUEST_MS = 6_000;
/** Placeholder: a map response bigger than this is refused (the recorded 773 m route is about 11 KB). */
export const MAP_RESPONSE_MAX_BYTES = 64 * 1024;
/** Placeholder: the whole `start_route` tool (position, search, route) gives up after this long. */
export const ROUTE_TOOL_MS = 12_000;
/** Placeholder: a place is searched for within about this far of her, each way. */
export const PLACE_SEARCH_RADIUS_M = 5_000;
/** Placeholder: a longer walking route is refused. */
export const ROUTE_MAX_M = 5_000;
/** Placeholder: a step shorter than this is folded with the one after it, so two turns never come seconds apart. */
export const STEP_FOLD_M = 10;
/** Placeholder: a walker's pace for minutes left (800 m is about 11 minutes). */
export const WALK_SPEED_MPS = 1.2;
/** Placeholder: how often the Navigator reads the position while a route is on. */
export const NAV_TICK_MS = 1_000;
/** Placeholder: "In 30 meters, ..." once she is this close to the next step. */
export const NAV_AHEAD_M = 40;
/** Placeholder: "Turn left now." once she is this close to the step's point, or past it. */
export const NAV_NOW_M = 8;
/** Placeholder: a position this far from the route counts as off it (two in a row plan again). */
export const NAV_OFF_ROUTE_M = 30;
/** Placeholder: planning again happens at most this often... */
export const NAV_REROUTE_GAP_MS = 20_000;
/** ...and at most this many times a route. */
export const NAV_REROUTES_MAX = 5;
/** Placeholder: within this of the end she has arrived. */
export const NAV_ARRIVE_M = 15;
/** Placeholder: the arrival stays on screen this long, then the route ends. */
export const NAV_ARRIVED_HOLD_MS = 20_000;
/** Placeholder: no position for this long says "I've lost the GPS position." */
export const NAV_LOST_MS = 15_000;
/** A GPS position older than this is not a new position for the Navigator. */
export const NAV_POSITION_MAX_AGE_MS = 5_000;
/** The simulated position's walking pace, before WALKER_SIM_WALK_SPEEDUP. */
export const SIM_WALK_MPS = 1.2;

// ---- Cloud (the interval is the walker contract's; the timeouts are placeholders) ----

export const HEARTBEAT_INTERVAL_MS = CONTRACT_HEARTBEAT_INTERVAL_MS;
/** The Pi counts itself offline after this many heartbeats fail in a row. */
export const OFFLINE_AFTER_FAILED_HEARTBEATS = 2;
/** A turn (or a Confirm answer) with no answer by then puts the Pi offline. */
export const TURN_DEADLINE_MS = 10000;
/** Placeholder, not measured: how long one heartbeat may take. */
export const HEARTBEAT_DEADLINE_MS = 5000;
/** After a messages fetch fails for a reason other than the network (an older server has no route), wait this long. */
export const MESSAGES_RETRY_MS = 60_000;
/** Placeholder, not measured: retry delays after failed heartbeats; the last one repeats. */
export const HEARTBEAT_BACKOFF_MS = [5000, 10000, 15000] as const;

// ---- Asking for help (src/help.ts; the HELP_* timings shared with the server are the contract's, walker.ts) ----

/** Placeholder: a help request that couldn't be sent is tried again this long after each failure (the design's 5 s). */
export const HELP_SEND_RETRY_EVERY_MS = 5_000;
/** Placeholder, not measured: one try of a help call (ask, status, okay) with no answer by then counts as failed. */
export const HELP_CALL_DEADLINE_MS = 10_000;
/** Placeholder (the design's 10 s): `closed` and `not_sent` stay on the walker screen this long, then it goes back. */
export const HELP_RESULT_SHOWN_MS = 10_000;
/** After GET /help answers 404 (an older server), the walker doesn't ask again for this long (like the messages feed). */
export const HELP_STATUS_RETRY_MS = 60_000;

// ---- The lift client (src/motion/lift/; the lift's own timings are motion.ts's) ----

/**
 * Placeholder, not measured: a lift command with no `lift.ack` this long after it was written is given up
 * (a `lift.stop` follows). The lift answers in the same loop that reads the line, so this only covers a lost line.
 */
export const LIFT_ACK_TIMEOUT_MS = 500;
/** Placeholder: a `lift.stop` with no ack is written again (with a new request id) at most this many times. */
export const LIFT_STOP_RETRIES = 3;

