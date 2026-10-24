"use client";

import type { Question, SessionView } from "@walker/contracts";
import type { Onboarding } from "@/lib/useOnboarding";
import { DemoView } from "./DemoScreen";

/** Development only: renders the demo from a fixed session so it can be inspected and screenshotted. */
export function PreviewHarness({ session, opening }: { session: SessionView | null; opening: Question }) {
  const no = async () => false;
  const o: Onboarding = {
    phase: session ? "ready" : "none",
    session,
    busy: false,
    status: "",
    error: null,
    questionKey: 0,
    start: async () => null,
    answer: no,
    skip: no,
    skipRest: no,
    revisit: no,
    confirm: no,
    reset: no,
    clearError: () => undefined,
  };
  return <DemoView o={o} opening={opening} />;
}
