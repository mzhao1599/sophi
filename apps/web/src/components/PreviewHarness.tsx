"use client";

import type { SessionView } from "@walker/contracts";
import type { Onboarding } from "@/lib/useOnboarding";
import { OnboardingView } from "./OnboardingScreen";
import { ReviewView } from "./ReviewScreen";

/** Development only: renders a screen from a fixed session so it can be inspected and screenshotted. */
export function PreviewHarness({ screen, session }: { screen: "onboarding" | "review"; session: SessionView | null }) {
  const noop = async () => undefined;
  const o: Onboarding = {
    phase: session ? "ready" : "none",
    session,
    busy: false,
    status: "",
    error: null,
    questionKey: 0,
    arrivedAfterReset: false,
    start: noop,
    answer: async () => false,
    skip: noop,
    skipRest: noop,
    revisit: noop,
    updateFact: async () => false,
    removeFact: noop,
    confirm: async () => false,
    reset: async () => false,
    clearError: () => undefined,
  };
  return screen === "onboarding" ? <OnboardingView o={o} /> : <ReviewView o={o} />;
}
