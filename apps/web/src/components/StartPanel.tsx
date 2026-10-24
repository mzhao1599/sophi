"use client";

import styles from "./StartPanel.module.css";

const TOPICS = [
  "What you'd like help with",
  "Where you'll use the walker",
  "What's easiest for you to notice",
  "How you'd like to ask for help",
  "What you'd like to reach, if that's one of your tasks",
  "Whether someone should see where the walker is",
];

/** The first screen of onboarding: what this is, how the demo treats your answers, and one way in. */
export function StartPanel({ busy, error, onStart, agent = false }: { busy: boolean; error: string | null; onStart(): void; agent?: boolean }) {
  return (
    <div className={styles.grid}>
      <section className={styles.main} aria-labelledby="start-heading">
        <h1 id="start-heading" className={styles.title}>
          Set up your walker
        </h1>
        <p className={styles.lead}>
          Answer a few short questions about what you&apos;d like help with. You&apos;ll get a short list of modules that fit, with the
          reason for each, and you decide what to keep.
        </p>

        <div className={styles.panel}>
          <h2 className={styles.heading}>Before you start</h2>
          <ul className={styles.notes}>
            <li>
              This is a demo. Your answers are kept in this server&apos;s memory for an hour after your last change, then deleted.
              You can delete them sooner at any time.
            </li>
            {agent ? (
              <li>
                An AI model, Anthropic&apos;s Claude, reads your answers to choose the next question, so what you choose and type is
                also sent to Anthropic. Deleting your answers here doesn&apos;t recall what was already sent. Fixed rules, not the
                model, suggest your modules, and you decide.
              </li>
            ) : null}
            <li>We ask about tasks and preferences, not health conditions. Please leave out names, addresses and medical details.</li>
            <li>This version works by typing and choosing. Speaking to the walker comes later, so no microphone is needed.</li>
            <li>Nothing here is installed yet. Choosing a module records what you want; bench tests decide what can be turned on.</li>
          </ul>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            {/* aria-disabled while starting, so focus stays here until the first question's heading takes it. */}
            <button
              type="button"
              className="button button-primary"
              onClick={() => {
                if (!busy) onStart();
              }}
              aria-disabled={busy || undefined}
            >
              {busy ? "Starting…" : "Start the demo"}
            </button>
            <p className={styles.consent}>Starting means you&apos;ve read how the demo keeps your answers.</p>
          </div>
        </div>
      </section>

      <aside className={styles.aside} aria-labelledby="topics-heading">
        <h2 id="topics-heading" className={styles.heading}>
          What we&apos;ll ask about
        </h2>
        <ul className={styles.topics}>
          {TOPICS.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <p className={styles.time}>
          {agent ? "About six short questions, fewer if you cover several at once." : "Six or seven short questions."} You can skip any
          of them.
        </p>
      </aside>
    </div>
  );
}
