"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SessionView } from "@walker/contracts";
import { WalkerMark } from "./WalkerMark";
import styles from "./TopBar.module.css";

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Who is signed in, as the server saw it; null when nobody is. */
export interface AccountSummary {
  email: string | null;
}

/**
 * The shell's one bar: the product, the session's scope (demo or account), a way to delete
 * everything now, and the way to sign in or to your saved setups. `signIn` is false when the server
 * has no Supabase, so there is nothing to sign in to.
 */
export function TopBar({
  session,
  onReset,
  busy,
  account = null,
  signIn = false,
}: {
  session: SessionView | null;
  onReset?: () => void;
  busy?: boolean;
  account?: AccountSummary | null;
  signIn?: boolean;
}) {
  const path = usePathname();
  // A confirmed account setup is deleted from Your setups, behind a confirmation, not with one click here.
  const canReset = onReset && !(session?.kind === "account" && session.state === "confirmed");
  const accountLink = account ? (
    <Link href="/setups" className={`button-text ${styles.link}`} aria-current={path === "/setups" ? "page" : undefined}>
      Your setups
    </Link>
  ) : signIn ? (
    <Link href={`/login?next=${encodeURIComponent(path === "/onboarding/review" ? path : "/onboarding")}`} className={`button-text ${styles.link}`}>
      Sign in
    </Link>
  ) : null;
  return (
    <header className={styles.bar}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          <WalkerMark />
          <span>Assistive Walker</span>
        </Link>
        <div className={styles.scope}>
          {session && session.state !== "expired" ? (
            <>
              <span className={`${styles.session} ${styles.wide}`}>
                {session.kind === "account" ? (
                  "Saved to your account"
                ) : (
                  <>
                    Demo session
                    {session.state !== "confirmed" ? <span className={styles.expiry}> · answers deleted at {clock(session.expires_at)}</span> : null}
                  </>
                )}
              </span>
              {canReset ? (
                <button type="button" className="button-text" onClick={onReset} disabled={busy}>
                  Delete <span className={styles.wide}>my </span>answers
                </button>
              ) : null}
            </>
          ) : (
            <span className={`${styles.session} ${styles.wide}`}>
              {account ? `Signed in${account.email ? ` as ${account.email}` : ""}` : "Prototype · demo mode"}
            </span>
          )}
          {accountLink}
        </div>
      </div>
    </header>
  );
}
