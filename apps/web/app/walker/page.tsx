import type { Metadata } from "next";
import { WalkerScreen } from "@/components/WalkerScreen";
import { walkerTypedModel } from "@/server/walker";

export const metadata: Metadata = { title: "Your walker" };

/**
 * "Your walker": pair a walker, watch it live, read its conversation, ask it something and answer what it
 * offers. Separate from the onboarding demo on `/`. `?fake=1` swaps in the development fake of the page
 * API (never in production builds), with a banner saying so.
 */
export default async function WalkerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { fake } = await searchParams;
  // Read on the server: who reads typed words here (Claude, Gemini or none), for the notice. No key reaches the page.
  return <WalkerScreen fake={process.env.NODE_ENV !== "production" && fake !== undefined} typedBy={walkerTypedModel()} />;
}
