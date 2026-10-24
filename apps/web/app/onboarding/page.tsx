import type { Metadata } from "next";
import { OnboardingScreen } from "@/components/OnboardingScreen";

export const metadata: Metadata = { title: "Set up your walker" };

export default function OnboardingPage() {
  return <OnboardingScreen />;
}
