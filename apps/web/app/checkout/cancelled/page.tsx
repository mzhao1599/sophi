import type { Metadata } from "next";
import { CheckoutResult } from "@/components/CheckoutResult";

export const metadata: Metadata = { title: "Demo checkout cancelled", robots: { index: false, follow: false } };

/** Stripe's back link lands here. Nothing is read from the URL. */
export default function CheckoutCancelledPage() {
  return <CheckoutResult order={{ kind: "cancelled" }} />;
}
