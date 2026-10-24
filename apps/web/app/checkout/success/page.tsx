import type { Metadata } from "next";
import { CheckoutResult } from "@/components/CheckoutResult";
import { loadDemoOrder } from "@/server/checkout/order";
import { getCheckout } from "@/server/checkout/stripe";

export const metadata: Metadata = { title: "Demo order", robots: { index: false, follow: false } };

/** Stripe sends people here after a test payment. The order shown is read from Stripe, not from the URL. */
export default async function CheckoutSuccessPage({ searchParams }: { searchParams: Promise<{ session_id?: string | string[] }> }) {
  const { session_id } = await searchParams;
  const access = getCheckout();
  const order = access.ok
    ? await loadDemoOrder(access.client, typeof session_id === "string" ? session_id : undefined)
    : ({ kind: "off" } as const);
  return <CheckoutResult order={order} />;
}
