import type { Metadata } from "next";
import { RoseSample } from "@/components/SampleScreens";

export const metadata: Metadata = { title: "Sample: Rose's phone", robots: { index: false } };

/** /sample/rose: a sample of Rose's phone with her messages from Maya, for a glance on stage. Made-up data. */
export default function RoseSamplePage() {
  return <RoseSample />;
}
