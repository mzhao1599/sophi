import type { Metadata } from "next";
import { CaretakerSample } from "@/components/SampleScreens";

export const metadata: Metadata = { title: "Sample: Maya's phone", robots: { index: false } };

/** /sample/caretaker: a sample of Maya's phone with Rose's walk on a map, for a glance on stage. Made-up data. */
export default function CaretakerSamplePage() {
  return <CaretakerSample />;
}
