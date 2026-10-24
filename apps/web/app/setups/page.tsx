import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { MODULE_CATALOG } from "@walker/contracts";
import { latestOpenSessionId, listSetups } from "@walker/cloud-api";
import { DeleteAccount, SetupsList, type SetupSummary } from "@/components/SetupsList";
import { TopBar } from "@/components/TopBar";
import { signOut } from "@/server/auth-actions";
import { accountsAvailable } from "@/server/onboarding";
import { requestAuth } from "@/server/supabase";
import screen from "@/components/Screen.module.css";
import styles from "@/components/Account.module.css";

export const metadata: Metadata = { title: "Your setups" };

/** A signed-in user's saved setups, their unfinished one if any, and their account controls. */
export default async function SetupsPage() {
  await connection();
  if (!accountsAvailable()) redirect("/login");
  const { client, user } = await requestAuth();
  if (!client || !user) redirect("/login?next=/setups");

  const [setups, openId] = await Promise.all([listSetups(client), latestOpenSessionId(client)]);
  const summaries: SetupSummary[] = setups.map(({ session_id, configuration }) => ({
    session_id,
    version: configuration.configuration_version,
    confirmed_at: configuration.confirmed_at,
    modules: configuration.selected_module_ids.map((id) => MODULE_CATALOG.modules.find((m) => m.id === id)?.name ?? id),
  }));

  return (
    <>
      <TopBar account={{ email: user.email }} signIn />
      <main id="main" className={screen.main}>
        <div className={screen.grid}>
          <div className={styles.column}>
            <h1 className={screen.doneTitle}>Your setups</h1>
            <p className={screen.lead}>
              Each setup is the walker configuration you confirmed, numbered in order. They stay in your account until you delete them;
              deleting one also deletes the answers it came from.
            </p>
            <div className={screen.actions}>
              <Link href="/onboarding" className="button button-primary">
                {openId ? "Carry on with your unfinished setup" : "Set up a walker"}
              </Link>
            </div>

            <SetupsList setups={summaries} />

            <section aria-labelledby="account-heading" className={styles.panel}>
              <h2 id="account-heading" className={styles.heading}>
                Your account
              </h2>
              <p className={styles.meta}>Signed in{user.email ? ` as ${user.email}` : ""}.</p>
              <div className={styles.actions}>
                <form action={signOut}>
                  <button type="submit" className="button button-secondary">
                    Sign out
                  </button>
                </form>
                <DeleteAccount />
              </div>
            </section>
          </div>
        </div>
      </main>
    </>
  );
}
