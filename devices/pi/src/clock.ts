/**
 * Time, injected everywhere so tests drive it with a fake clock and never sleep.
 * `now()` is wall time, used only for timestamps the cloud reads. `monotonic()` never jumps backwards, so
 * freshness, deadlines and rate limits use it (docs/interfaces.md: judge freshness by the Pi's monotonic
 * receive time).
 */
export type Cancel = () => void;

export interface Clock {
  now(): number;
  monotonic(): number;
  setTimeout(fn: () => void, ms: number): Cancel;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

export class DeadlineError extends Error {
  override name = "DeadlineError";
}

/** The reason a caller aborts work on purpose (a Talk press cancelling a turn, or shutdown). */
export class CancelledError extends Error {
  override name = "CancelledError";
}

/**
 * Runs `work` with a signal that aborts after `ms` on `clock`, or when `outer` aborts. Rejects at the deadline
 * even if `work` ignores its signal.
 */
export async function withDeadline<T>(
  clock: Clock,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const cancelTimer = clock.setTimeout(() => controller.abort(new DeadlineError(`No answer within ${ms} ms.`)), ms);
  const onOuter = () => controller.abort(outer?.reason);
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener("abort", onOuter, { once: true });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason);
    if (controller.signal.aborted) onAbort();
    else controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } finally {
    cancelTimer();
    outer?.removeEventListener("abort", onOuter);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    aborted.catch(() => {});
  }
}
