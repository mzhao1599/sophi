"use client";

import Link from "next/link";
import type { SessionView } from "@walker/contracts";
import { WalkerMark } from "./WalkerMark";
import styles from "./TopBar.module.css";

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The shell's one bar: the product, the demo scope, and a way to delete everything now. */
export function TopBar({ session, onReset, busy }: { session: SessionView | null; onReset?: () => void; busy?: boolean }) {
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
                Demo session
                {session.state !== "confirmed" ? <span className={styles.expiry}> · answers deleted at {clock(session.expires_at)}</span> : null}
              </span>
              {onReset ? (
                <button type="button" className="button-text" onClick={onReset} disabled={busy}>
                  Delete <span className={styles.wide}>my </span>answers
                </button>
              ) : null}
            </>
          ) : (
            <span className={`${styles.session} ${styles.wide}`}>Prototype · demo mode</span>
          )}
        </div>
      </div>
    </header>
  );
}
