"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared motion helpers. The living background "surges" (moves faster for about 1.5 s) when the agent
 * replies or the view changes; anything can ask for that with surge(), without a reference to it.
 */

const SURGE_EVENT = "walker:surge";

export function surge() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SURGE_EVENT));
}

export function onSurge(listener: () => void): () => void {
  window.addEventListener(SURGE_EVENT, listener);
  return () => window.removeEventListener(SURGE_EVENT, listener);
}

const REDUCE = "(prefers-reduced-motion: reduce)";

function subscribeReduced(callback: () => void) {
  const query = window.matchMedia(REDUCE);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

/** True when the person asked for reduced motion. False during server rendering. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReduced,
    () => window.matchMedia(REDUCE).matches,
    () => false,
  );
}

/**
 * How fast the background moves `ms` after a surge started: 1 at rest, rising on a sin² bell to
 * 1 + peak at the middle of `length`, back to 1 at the end. Pure, so it can be tested.
 */
export function surgeSpeed(ms: number, length = 1500, peak = 4): number {
  if (ms < 0 || ms > length) return 1;
  const s = Math.sin((Math.PI * ms) / length);
  return 1 + peak * s * s;
}
