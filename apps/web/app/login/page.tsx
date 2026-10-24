import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { TopBar } from "@/components/TopBar";
import { safeNext } from "@/server/next-path";
import { accountsAvailable } from "@/server/onboarding";
import { requestAuth } from "@/server/supabase";
import screen from "@/components/Screen.module.css";
import styles from "@/components/Account.module.css";

export const metadata: Metadata = { title: "Sign in" };

type Props = { searchParams: Promise<{ next?: string | string[]; error?: string | string[]; deleted?: string | string[] }> };

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const available = accountsAvailable();
  const { user } = await requestAuth();
  if (user) redirect(next);

  return (
    <>
      <TopBar session={null} />
      <main id="main" className={screen.main}>
        <div className={screen.grid}>
          <div className={styles.column}>
            {available ? (
              <LoginForm next={next} linkFailed={params.error === "link"} accountDeleted={params.deleted === "1"} />
            ) : (
              <section aria-labelledby="login-heading">
                <h1 id="login-heading" className={screen.doneTitle}>
                  Sign-in isn&apos;t set up here
                </h1>
                <p className={screen.lead}>This server has no account database, so only the demo is available.</p>
              </section>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
