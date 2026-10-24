import type { LiftSerialMessage } from "@walker/contracts";

/**
 * The lift board's port, as the module manager hands it to the lift client (src/motion/lift/). The lift speaks
 * the same JSON Lines as the other boards but its own `lift.*` types (packages/contracts/src/lift-serial.ts), so
 * the first `hello` or `lift.hello` on a port decides which parser reads it from then on (the contract's rule
 * for `parseLiftSerialLine`). A lift port's lines never reach the module list, the manifest or its logs.
 */

type PiCommand = Extract<
  LiftSerialMessage,
  { type: "lift.heartbeat" | "lift.home" | "lift.move" | "lift.stop" | "lift.enable" | "lift.clear" }
>;
type WithoutEnvelope<T> = T extends unknown ? Omit<T, "v" | "seq"> : never;
/** A Pi → lift line before the port stamps its `v` and `seq`. (`hello.request` goes through `requestHello`.) */
export type LiftPiLine = WithoutEnvelope<PiCommand>;

export interface LiftPortLink {
  /** The port's name, for logs. */
  readonly portId: string;
  readonly simulated: boolean;
  /**
   * Writes these lines in ONE write (a real port takes one write at a time, so two writes in a row would drop
   * the second), stamping `v` and each line's `seq` from the port's own counter, which `hello.request` shares.
   * Every line is checked against LiftSerialMessageSchema first. Returns false when nothing was written: a line
   * failed the check or was too long, or the port is closed or still busy. The counter moves only on success.
   */
  send(lines: readonly LiftPiLine[]): boolean;
  /** Sends `hello.request` to the lift (which stops it, rule 2), at most every HELLO_REQUEST_MIN_GAP_MS. */
  requestHello(target: string): boolean;
}

export interface LiftLineHandler {
  /** Every parsed line from a lift port, from its `lift.hello` on. */
  liftLine(link: LiftPortLink, message: LiftSerialMessage): void;
  /** A line on a lift port that didn't parse (the lift's parser's problem code). */
  liftLineRefused(link: LiftPortLink, problem: string): void;
  /** The lift port closed (unplugged, or the Pi closed it). */
  liftPortClosed(link: LiftPortLink, reason: string): void;
}
