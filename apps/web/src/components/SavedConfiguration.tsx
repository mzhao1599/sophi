"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { MODULE_CATALOG, type DeviceConfiguration, type SessionView } from "@walker/contracts";
import { CheckoutButton } from "./CheckoutButton";
import screen from "./Screen.module.css";
import styles from "./SavedConfiguration.module.css";

const CUE: Record<DeviceConfiguration["preferences"]["cues"][number], string> = {
  vibration: "a vibration in the handles",
  spoken: "a spoken message",
  sound: "a short sound",
  screen: "text on a phone or tablet",
};

const START: Record<DeviceConfiguration["preferences"]["request_start"][number], string> = {
  left_button: "the left handle button",
  right_button: "the right handle button",
  voice: "saying it out loud",
  app: "typing in the app",
};

function list(items: string[], none: string) {
  if (items.length === 0) return none;
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/** After confirmation: what was saved, what the walker would receive, and what happens next. */
export function SavedConfiguration({
  session,
  configuration,
  busy,
  onStartOver,
}: {
  session: SessionView;
  configuration: DeviceConfiguration;
  busy: boolean;
  onStartOver(): Promise<boolean>;
}) {
  const router = useRouter();
  const [deleteFailed, setDeleteFailed] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);
  const modules = configuration.selected_module_ids.map((id) => MODULE_CATALOG.modules.find((m) => m.id === id)!);
  const saved = new Date(configuration.confirmed_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className={screen.grid}>
      <header className={screen.span12}>
        <h1 ref={headingRef} tabIndex={-1} className={screen.doneTitle}>
          Your setup is saved
        </h1>
        <p className={screen.lead}>
          {configuration.source === "account" ? (
            <>
              Setup {configuration.configuration_version}, saved to your account at {saved}. The next step is pairing it with a walker,
              which isn&apos;t built yet.
            </>
          ) : (
            <>
              Configuration {configuration.configuration_version}, saved at {saved}. The next step is pairing it with a walker, which
              isn&apos;t built yet. This demo configuration can&apos;t be sent to a real device.
            </>
          )}
        </p>
      </header>

      {/* One panel for what was saved, so its two halves share a top and a bottom edge. */}
      <div className={`${screen.span12} ${styles.panel} ${styles.split}`}>
        <section className={styles.modulesPart} aria-labelledby="saved-modules">
          <h2 id="saved-modules" className={styles.heading}>
            On your walker
          </h2>
          <ul className={styles.modules}>
            {modules.map((m) => (
              <li key={m.id}>
                <p className={styles.name}>{m.name}</p>
                <p className={styles.meta}>{m.placement}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.prefsPart} aria-labelledby="saved-prefs">
          <h2 id="saved-prefs" className={styles.heading}>
            How it reaches you
          </h2>
          <dl className={styles.prefs}>
            <div>
              <dt>Cues</dt>
              <dd>{list(configuration.preferences.cues.map((c) => CUE[c]), "Not chosen yet")}</dd>
            </div>
            <div>
              <dt>Start a request with</dt>
              <dd>{list(configuration.preferences.request_start.map((c) => START[c]), "Not chosen yet")}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className={`${screen.span12} ${styles.panel}`} aria-labelledby="saved-json">
        <h2 id="saved-json" className={styles.heading}>
          What the walker would receive
        </h2>
        <p className={styles.meta}>
          The Raspberry Pi fetches this versioned configuration after pairing. It then checks which modules are actually
          connected and healthy before turning anything on.
        </p>
        <pre className={styles.code}>
          <code>{JSON.stringify(configuration, null, 2)}</code>
        </pre>
      </section>

      <CheckoutButton className={screen.span12} sessionId={session.session_id} configurationVersion={configuration.configuration_version} />

      {configuration.source === "account" ? (
        <div className={`${screen.span12} ${screen.actions}`}>
          <Link href="/setups" className="button button-secondary">
            See all your setups
          </Link>
          <Link href="/onboarding" className="button-text">
            Set up another walker
          </Link>
          <p className={styles.meta}>Kept in your account until you delete it in Your setups.</p>
        </div>
      ) : (
        <div className={`${screen.span12} ${screen.actions}`}>
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={async () => {
              const deleted = await onStartOver();
              setDeleteFailed(!deleted);
              if (deleted) router.push("/onboarding");
            }}
          >
            Delete and start over
          </button>
          {deleteFailed ? (
            <p role="alert" className={styles.meta}>
              Your answers couldn&apos;t be deleted just now. Please try again.
            </p>
          ) : null}
          <p className={styles.meta}>Session {session.session_id.slice(0, 8)} · deleted automatically within an hour.</p>
        </div>
      )}
    </div>
  );
}
