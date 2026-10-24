"use client";

import { useEffect, useId, useState } from "react";
import { fetchCheckoutStatus, startCheckout, type CheckoutStatus } from "@/lib/checkout";
import styles from "./Checkout.module.css";

const OFF: Record<Exclude<CheckoutStatus["reason"], "ready">, string> = {
  missing_key: "Mock purchase is off: this server has no Stripe test key.",
  not_test_key: "Mock purchase is off: the server's Stripe key isn't a test key, so it was refused.",
};

/**
 * "Mock purchase this setup": sends the saved setup to Stripe's hosted test-mode Checkout. We never
 * build a card form; the server prices the confirmed configuration and returns Stripe's URL.
 */
export function CheckoutButton({
  sessionId,
  configurationVersion,
  className = "",
}: {
  sessionId: string;
  configurationVersion: number;
  className?: string;
}) {
  const [status, setStatus] = useState<CheckoutStatus | "loading" | "unknown">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headingId = useId();
  const noticeId = useId();
  const stateId = useId();

  useEffect(() => {
    let current = true;
    fetchCheckoutStatus().then(
      (s) => current && setStatus(s),
      () => current && setStatus("unknown"),
    );
    return () => {
      current = false;
    };
  }, []);

  const enabled = typeof status === "object" && status.enabled;
  const stateText =
    status === "loading"
      ? "Checking whether mock purchase is on…"
      : status === "unknown"
        ? "Couldn't check whether mock purchase is on. Reload the page to try again."
        : status.enabled
          ? null
          : OFF[status.reason as keyof typeof OFF];

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      window.location.assign(await startCheckout(sessionId, configurationVersion));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't open the test checkout. Please try again.");
      setBusy(false);
    }
  }

  return (
    <section className={`${className} ${styles.panel}`} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.heading}>
        Try a mock purchase
      </h2>
      <p id={noticeId} className={styles.notice}>
        <span className="pill pill-consider">Test mode, no real charge</span>{" "}
        This opens Stripe&apos;s test checkout page. Pay with Stripe&apos;s test card 4242 4242 4242 4242, any future date and any
        CVC; Stripe asks for an email, and a made-up one works. Prices are demo prices, not a real quote. The walker is an
        experimental prototype, not a certified mobility aid, so nothing will ship.
      </p>
      <div className={styles.row}>
        <button
          type="button"
          className="button button-primary"
          disabled={!enabled || busy}
          aria-describedby={stateText ? `${noticeId} ${stateId}` : noticeId}
          onClick={onClick}
        >
          {busy ? "Opening test checkout…" : "Mock purchase this setup"}
        </button>
        <p id={stateId} className={styles.state} aria-live="polite">
          {stateText}
        </p>
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
