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
export const NEAR_ENTER_MM = 500;
/** Placeholder, not measured: a near zone clears only over this distance (hysteresis). */
export const NEAR_EXIT_MM = 650;
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
/** Placeholder, not measured: speaking rate used to turn caption pages (Piper and Cartesia both sound near this). */
export const CAPTION_CHARS_PER_S = 15;
/** Placeholder, not measured: the shortest time a caption page shows. */
export const CAPTION_PAGE_MIN_MS = 2500;
/** Placeholder, not measured: "Something close" stays this long after the last near reading, so a pass is readable. */
export const SCREEN_OBSTACLE_TAIL_MS = 1000;
/** Placeholder: zones arrive at the sensor's rate; the screen redraws a changed distance at most this often. */
export const SCREEN_ZONES_MIN_MS = 250;

// ---- Cloud (the interval is the walker contract's; the timeouts are placeholders) ----

export const HEARTBEAT_INTERVAL_MS = CONTRACT_HEARTBEAT_INTERVAL_MS;
/** The Pi counts itself offline after this many heartbeats fail in a row. */
export const OFFLINE_AFTER_FAILED_HEARTBEATS = 2;
/** A turn (or a Confirm answer) with no answer by then puts the Pi offline. */
export const TURN_DEADLINE_MS = 10000;
/** Placeholder, not measured: how long one heartbeat may take. */
export const HEARTBEAT_DEADLINE_MS = 5000;
/** Placeholder, not measured: retry delays after failed heartbeats; the last one repeats. */
export const HEARTBEAT_BACKOFF_MS = [5000, 10000, 15000] as const;

// ---- The lift client (src/motion/lift/; the lift's own timings are motion.ts's) ----

/**
 * Placeholder, not measured: a lift command with no `lift.ack` this long after it was written is given up
 * (a `lift.stop` follows). The lift answers in the same loop that reads the line, so this only covers a lost line.
 */
export const LIFT_ACK_TIMEOUT_MS = 500;
/** Placeholder: a `lift.stop` with no ack is written again (with a new request id) at most this many times. */
export const LIFT_STOP_RETRIES = 3;

