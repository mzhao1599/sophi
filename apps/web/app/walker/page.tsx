import type { Metadata } from "next";
import { WalkerScreen } from "@/components/WalkerScreen";

export const metadata: Metadata = { title: "Your walker" };

/**
 * "Your walker": pair a walker, watch it live, read its conversation, ask it something and answer what it
 * offers. Separate from the onboarding demo on `/`. `?fake=1` swaps in the development fake of the page
 * API (never in production builds), with a banner saying so.
 */
export default async function WalkerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { fake } = await searchParams;
  return <WalkerScreen fake={process.env.NODE_ENV !== "production" && fake !== undefined} />;
}
