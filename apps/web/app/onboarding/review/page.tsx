import type { Metadata } from "next";
import { connection } from "next/server";
import { ReviewScreen } from "@/components/ReviewScreen";
import { screenAccess } from "@/server/onboarding";

export const metadata: Metadata = { title: "Choose your modules" };

export default async function ReviewPage() {
  // Rendered per request, for the visitor's sign-in state and unfinished setup.
  await connection();
  return <ReviewScreen {...await screenAccess()} />;
}
