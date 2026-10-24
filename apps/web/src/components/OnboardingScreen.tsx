"use client";

import Link from "next/link";
import { useLayoutEffect, useRef } from "react";
import { MODULE_CATALOG, type ModuleId, type SessionView } from "@walker/contracts";
import { useOnboarding, type Onboarding } from "@/lib/useOnboarding";
import { FactsPanel } from "./FactsPanel";
import { QuestionStep } from "./QuestionStep";
import { StartPanel } from "./StartPanel";
import { TopBar, type AccountSummary } from "./TopBar";
import { Transcript } from "./Transcript";
import { WalkerDiagram, type PartState } from "./WalkerDiagram";
import styles from "./Screen.module.css";

/**
 * The walker as the answers have shaped it so far: suggested modules dashed, the frame solid. After
 * saving, the saved modules are solid. Nothing here is chosen; choosing happens on the review page.
 */
function SuggestedWalker({ session }: { session: SessionView }) {
  const saved = session.state === "confirmed" ? session.configuration?.selected_module_ids : undefined;
  const status = new Map(session.recommendations.map((r) => [r.module_id, r.status]));
  const states = Object.fromEntries(
    MODULE_CATALOG.modules.map((m) => {
      const st = status.get(m.id);
      const state: PartState = saved
        ? saved.includes(m.id)
          ? "selected"
          : "off"
        : st === "required"
          ? "selected"
          : st === "recommended" || st === "consider"
            ? "suggested"
            : st === "unavailable"
              ? "unavailable"
              : "off";
      return [m.id, state];
    }),
  ) as Record<ModuleId, PartState>;
  const nameOf = (id: ModuleId) => MODULE_CATALOG.modules.find((m) => m.id === id)!.name;
  const suggested = MODULE_CATALOG.modules.filter((m) => states[m.id] === "suggested").map((m) => m.name);
  const caption = saved
    ? `On your saved walker: ${saved.map(nameOf).join(", ")}.`
    : suggested.length > 0
      ? `Suggested so far: ${suggested.join(", ")}. The frame is part of every setup.`
      : "Nothing is suggested yet beyond the frame, which is part of every setup.";

  return (
    <section className={styles.preview} aria-labelledby="preview-heading">
      <div className={styles.previewText}>
        <h2 id="preview-heading" className={styles.previewHeading}>
          {saved ? "Your saved walker" : "Your walker so far"}
        </h2>
        <p className={styles.previewNote}>
          {saved ? "Solid parts are on the configuration you saved." : "Dashed parts are suggestions from your answers. You choose what to keep on the next page."}
        </p>
      </div>
      <div className={styles.previewFigure}>
        <WalkerDiagram states={states} highlight={null} caption={caption} legend={!saved} />
      </div>
    </section>
  );
}

/**
 * The onboarding conversation. Screen question: "What's the next thing you'd like to tell me?" — the
 * current question is the biggest thing on the screen, the running summary sits beside it, and the
 * full transcript below keeps every message available as text.
 */
export interface ScreenAccess {
  /** The signed-in user, or null. Signed in, Start creates an account session; signed out, a demo. */
  account?: AccountSummary | null;
  /** The server has Supabase, so signing in is possible. */
  signIn?: boolean;
  /** The signed-in user's unfinished setup, to carry on with on this device. */
  resumeId?: string | null;
}

export function OnboardingScreen({ agent = false, account = null, signIn = false, resumeId = null }: { agent?: boolean } & ScreenAccess) {
  const o = useOnboarding({ notice: account ? "account" : "demo", resumeId });
  return <OnboardingView o={o} agent={agent} account={account} signIn={signIn} />;
}

/** `agent`: the server runs the onboarding agent, so the first screen says answers go to the model provider. */
export function OnboardingView({
  o,
  agent = false,
  account = null,
  signIn = false,
}: { o: Onboarding; agent?: boolean } & Omit<ScreenAccess, "resumeId">) {
  const s = o.session;
  const doneRef = useRef<HTMLHeadingElement>(null);
  const reviewReady = s && (s.state === "review" || s.state === "confirmed");

  // A layout effect, so focus moves in the same commit that removes the last question.
  useLayoutEffect(() => {
    if (reviewReady && o.questionKey > 1) doneRef.current?.focus();
  }, [reviewReady, o.questionKey]);

  return (
    <>
      <TopBar session={s} onReset={s ? o.reset : undefined} busy={o.busy} account={account} signIn={signIn} />
      <main id="main" className={styles.main}>
        <p className="visually-hidden" role="status" aria-live="polite">
          {o.status}
        </p>

        {o.phase === "loading" ? <p className={styles.loading}>Loading your setup…</p> : null}

        {o.phase === "none" ? (
          <StartPanel busy={o.busy} error={o.error} onStart={o.start} agent={agent} account={account} signIn={signIn} />
        ) : null}

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
              <SuggestedWalker session={s} />
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
