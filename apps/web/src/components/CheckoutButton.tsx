"use client";

import { useEffect, useId, useState } from "react";
import { fetchCheckoutStatus, startCheckout, type CheckoutStatus } from "@/lib/checkout";
import styles from "./Checkout.module.css";

const OFF: Record<Exclude<CheckoutStatus["reason"], "ready">, string> = {
  missing_key: "Ordering is off: this server has no Stripe test key.",
  not_test_key: "Ordering is off: the server's Stripe key isn't a test key, so it was refused.",
};

/**
 * "Order (demo)": sends the saved walker to Stripe's hosted test-mode Checkout. We never build a card
 * form; the server prices the confirmed configuration and returns Stripe's URL. The button stays
 * focusable while it checks or opens (aria-disabled), and a press then is ignored.
 */
export function CheckoutButton({ sessionId, configurationVersion }: { sessionId: string; configurationVersion: number }) {
  const [status, setStatus] = useState<CheckoutStatus | "loading" | "unknown">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noticeId = useId();
  const stateId = useId();
  const errorId = useId();

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
      ? "Checking whether ordering is on…"
      : status === "unknown"
        ? "Couldn't check whether ordering is on. Reload the page to try again."
        : status.enabled
          ? null
          : OFF[status.reason as keyof typeof OFF];

  async function onClick() {
    if (!enabled || busy) return;
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
    <div className={styles.order}>
      <button
        type="button"
        className="button button-primary"
        aria-disabled={!enabled || busy || undefined}
        aria-describedby={[noticeId, stateText ? stateId : "", error ? errorId : ""].filter(Boolean).join(" ")}
        onClick={() => void onClick()}
      >
        {busy ? "Opening checkout…" : "Order (demo)"}
      </button>
      <p id={noticeId} className={styles.notice}>
        Stripe test mode, no real charge. Test card <span className={styles.card}>4242 4242 4242 4242</span>.
      </p>
      <p id={stateId} className={styles.state} aria-live="polite">
        {stateText}
      </p>
      {error ? (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
