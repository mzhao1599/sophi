"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PRODUCT_NAME } from "@/lib/brand";
import type { AccountSummary } from "./DemoScreen";
import { WalkerMark } from "./WalkerMark";
import styles from "./TopBar.module.css";

/**
 * The bar on the pages beside the demo (sign-in, your setups, the checkout return pages): the
 * product, the scope, and for a signed-in user the way to their saved setups. The demo page has its
 * own bar with Start over. `signIn` is false when the server has no Supabase, so there is nothing to
 * sign in to.
 */
export function TopBar({ account = null, signIn = false }: { account?: AccountSummary | null; signIn?: boolean }) {
  const path = usePathname();
  const accountLink = account ? (
    <Link href="/setups" className={`button-text ${styles.link}`} aria-current={path === "/setups" ? "page" : undefined}>
      Your setups
    </Link>
  ) : signIn ? (
    <Link href="/login?next=/onboarding" className={`button-text ${styles.link}`}>
      Sign in
    </Link>
  ) : null;
  return (
    <header className={styles.bar}>
      <div className={styles.inner}>
        <Link href="/" className={styles.brand}>
          <WalkerMark />
          <span>{PRODUCT_NAME}</span>
        </Link>
        <div className={styles.scope}>
          <span className={`${styles.session} ${styles.wide}`}>
            {account ? `Signed in${account.email ? ` as ${account.email}` : ""}` : "Prototype · demo mode"}
          </span>
          {accountLink}
        </div>
      </div>
    </header>
  );
}
