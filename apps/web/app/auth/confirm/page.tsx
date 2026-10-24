import type { Metadata } from "next";
import { TopBar } from "@/components/TopBar";
import { confirmSignInLink } from "@/server/auth-actions";
import screen from "@/components/Screen.module.css";
import styles from "@/components/Account.module.css";

export const metadata: Metadata = { title: "Finish signing in" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function one(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

/**
 * Where the sign-in email's link lands. Opening the link signs nobody in: the button does, with a
 * POST. Email security scanners open links before people do, and would otherwise use up the
 * one-time link; and a link someone else sent can't sign you into their account without you
 * pressing the button.
 */
export default async function ConfirmPage({ searchParams }: Props) {
  const params = await searchParams;
  return (
    <>
      <TopBar session={null} />
      <main id="main" className={screen.main}>
        <div className={screen.grid}>
          <section className={styles.column} aria-labelledby="confirm-heading">
            <h1 id="confirm-heading" className={screen.doneTitle}>
              Finish signing in
            </h1>
            <p className={screen.lead}>Press the button to sign in on this device.</p>
            <form action={confirmSignInLink} className={styles.form}>
              <input type="hidden" name="token_hash" value={one(params.token_hash)} />
              <input type="hidden" name="type" value={one(params.type)} />
              <input type="hidden" name="code" value={one(params.code)} />
              <div className={styles.actions}>
                <button type="submit" className="button button-primary">
                  Sign in
                </button>
              </div>
            </form>
            <p className={styles.meta}>
              This extra step keeps email security scanners from using up your one-time link. If you didn&apos;t ask to sign in, close
              this page.
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
