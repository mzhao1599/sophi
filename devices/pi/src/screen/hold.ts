import { HOLD_CONTROL_REFRESH_MS, SCREEN_HOLD_RELEASE_EVENTS, type ScreenHold } from "@walker/contracts";

/**
 * The page's side of the lift's hold control (motion.ts: HoldSourceSchema `screen_hold_control`), kept apart
 * from React so its release paths can be tested on their own (test/screen-hold.test.ts).
 *
 * While her finger (or Space or Enter) is down on the control, it posts `{ pressed: true }` to /screen/hold at
 * once and then every HOLD_SEND_MS. It lets go, posting `{ pressed: false }` once, on the first of:
 * - any of SCREEN_HOLD_RELEASE_EVENTS anywhere on the page (pointerup, pointercancel, touchend, touchcancel
 *   and blur on the window, visibilitychange on the document), and any keyup;
 * - the control leaving the screen (`setShown(false)`: the state the Pi sent no longer shows it);
 * - the page losing its stream from the Pi (`streamLost()`).
 * The release events are heard on the whole window, not on the button, so a release is never missed because
 * the button moved, was redrawn or went. If a release never arrives (the page froze, the request was lost),
 * the refreshes stop and the hold lapses on the Pi after HOLD_CONTROL_REFRESH_MS.
 */

/**
 * "Still held" goes out four times per HOLD_CONTROL_REFRESH_MS. The contract asks for at least one per period;
 * the Pi's lift lease lapses, for good, the first control tick a refresh is older than that, so one late timer or
 * slow request at exactly the period would stop the lift under a finger that never moved.
 */
export const HOLD_SEND_MS = HOLD_CONTROL_REFRESH_MS / 4;

type Listenable = Pick<EventTarget, "addEventListener" | "removeEventListener">;

export interface HoldEnvironment {
  /** Pointer, touch, key and focus events. */
  window: Listenable;
  /** visibilitychange. */
  document: Listenable;
  /** Posts to /screen/hold. */
  send: (hold: ScreenHold) => void;
  /** The page's own clock, `performance.timeOrigin + performance.now()`: it only orders this page's messages. */
  now: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  /** Whether it is held, for drawing the control filled. */
  onChange?: (held: boolean) => void;
}

export class HoldControl {
  private shown = false;
  private held = false;
  private timer: unknown = null;
  private readonly letGo = () => this.release();

  constructor(private readonly env: HoldEnvironment) {}

  /** Starts listening for releases; returns the function that stops (and lets go). */
  attach(): () => void {
    const onWindow = SCREEN_HOLD_RELEASE_EVENTS.filter((name) => name !== "visibilitychange");
    for (const name of onWindow) this.env.window.addEventListener(name, this.letGo);
    this.env.window.addEventListener("keyup", this.letGo);
    this.env.document.addEventListener("visibilitychange", this.letGo);
    return () => {
      this.release();
      for (const name of onWindow) this.env.window.removeEventListener(name, this.letGo);
      this.env.window.removeEventListener("keyup", this.letGo);
      this.env.document.removeEventListener("visibilitychange", this.letGo);
    };
  }

  isHeld(): boolean {
    return this.held;
  }

  /** Whether the state on screen shows the control. Going away lets go at once. */
  setShown(shown: boolean): void {
    this.shown = shown;
    if (!shown) this.release();
  }

  /** The page's stream from the Pi dropped: it can't see what it would be holding. */
  streamLost(): void {
    this.setShown(false);
  }

  /** A finger or key went down on the control. */
  press(): void {
    if (!this.shown || this.held) return;
    this.held = true;
    this.post(true);
    this.timer = this.env.setInterval(() => this.post(true), HOLD_SEND_MS);
    this.env.onChange?.(true);
  }

  /** Let go: one release, and the refreshes stop. Does nothing when not held. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    this.env.clearInterval(this.timer);
    this.timer = null;
    this.post(false);
    this.env.onChange?.(false);
  }

  private post(pressed: boolean): void {
    this.env.send({ pressed, at: this.env.now() });
  }
}
