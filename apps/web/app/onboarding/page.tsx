import type { Metadata } from "next";
import { connection } from "next/server";
import { OnboardingScreen } from "@/components/OnboardingScreen";
import { onboarding } from "@/server/onboarding";

export const metadata: Metadata = { title: "Set up your walker" };

export default async function OnboardingPage() {
  // Rendered per request: the first screen says whether a model reads the answers, which depends on the server's settings.
  await connection();
  return <OnboardingScreen agent={onboarding.engine.kind === "agent"} />;
}
