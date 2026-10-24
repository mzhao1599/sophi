import type { Metadata } from "next";
import { ReviewScreen } from "@/components/ReviewScreen";

export const metadata: Metadata = { title: "Choose your modules" };

export default function ReviewPage() {
  return <ReviewScreen />;
}
