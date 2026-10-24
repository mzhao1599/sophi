"use client";

import { useEffect, useState } from "react";

/** This browser's clock, re-read every `intervalMs`, for countdowns and ages in the component that shows them. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
