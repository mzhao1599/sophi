"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { useOnboarding, type Onboarding } from "@/lib/useOnboarding";
import { FactsPanel } from "./FactsPanel";
import { QuestionStep } from "./QuestionStep";
import { StartPanel } from "./StartPanel";
import { TopBar } from "./TopBar";
import { Transcript } from "./Transcript";
import styles from "./Screen.module.css";

/**
 * The onboarding conversation. Screen question: "What's the next thing you'd like to tell me?" — the
 * current question is the biggest thing on the screen, the running summary sits beside it, and the
 * full transcript below keeps every message available as text.
 */
export function OnboardingScreen({ agent = false }: { agent?: boolean }) {
  return <OnboardingView o={useOnboarding()} agent={agent} />;
}

/** `agent`: the server runs the onboarding agent, so the first screen says answers go to the model provider. */
export function OnboardingView({ o, agent = false }: { o: Onboarding; agent?: boolean }) {
  const s = o.session;
  const doneRef = useRef<HTMLHeadingElement>(null);
  const reviewReady = s && (s.state === "review" || s.state === "confirmed");

  useEffect(() => {
    if (reviewReady && o.questionKey > 1) doneRef.current?.focus();
  }, [reviewReady, o.questionKey]);

  return (
    <>
      <TopBar session={s} onReset={s ? o.reset : undefined} busy={o.busy} />
      <main id="main" className={styles.main}>
        <p className="visually-hidden" role="status" aria-live="polite">
          {o.status}
        </p>

        {o.phase === "loading" ? <p className={styles.loading}>Loading your setup…</p> : null}

        {o.phase === "none" ? <StartPanel busy={o.busy} error={o.error} onStart={o.start} agent={agent} /> : null}

        {s && s.current_question ? (
          <div className={styles.grid}>
            <div className={styles.span8}>
              <QuestionStep
                key={`${s.current_question.id}-${s.turns.length}`}
                question={s.current_question}
                previous={s.current_answer}
                progress={s.progress}
                revisiting={Boolean(s.current_answer)}
                busy={o.busy}
                error={o.error}
                focusKey={o.questionKey}
                onAnswer={(ids, text) => o.answer(s.current_question!.id, ids, text)}
                onSkip={() => o.skip(s.current_question!.id)}
                onSkipRest={o.skipRest}
              />
            </div>
            <div className={styles.span4}>
              <FactsPanel
                facts={s.facts}
                recommendations={s.recommendations}
                editable
                busy={o.busy}
                onUpdate={o.updateFact}
                onRemove={o.removeFact}
              />
            </div>
            <div className={styles.span12}>
              <Transcript turns={s.turns} canChange busy={o.busy} onChange={o.revisit} />
            </div>
          </div>
        ) : null}

        {s && reviewReady ? (
          <div className={styles.grid}>
            <section className={styles.span8} aria-labelledby="done-heading">
              <h1 id="done-heading" ref={doneRef} tabIndex={-1} className={styles.doneTitle}>
                {s.state === "confirmed" ? "Your setup is saved" : "That's everything I need"}
              </h1>
              <p className={styles.lead}>
                {s.state === "confirmed"
                  ? "You can see the saved configuration on the review page."
                  : "Check what I understood on the right, then choose your modules. Nothing is saved until you confirm."}
              </p>
              {o.error ? (
                <p role="alert" className={styles.lead}>
                  {o.error}
                </p>
              ) : null}
              <div className={styles.actions}>
                <Link href="/onboarding/review" className="button button-primary">
                  {s.state === "confirmed" ? "See your saved setup" : "Review modules"}
                </Link>
              </div>
            </section>
            <div className={styles.span4}>
              <FactsPanel
                facts={s.facts}
                recommendations={s.recommendations}
                editable={s.state !== "confirmed"}
                busy={o.busy}
                onUpdate={o.updateFact}
                onRemove={o.removeFact}
              />
            </div>
            <div className={styles.span12}>
              <Transcript turns={s.turns} canChange={s.state !== "confirmed"} busy={o.busy} onChange={o.revisit} />
            </div>
          </div>
        ) : null}
      </main>
    </>
  );
}
