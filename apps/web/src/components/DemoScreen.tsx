"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModuleId, Question, QuestionId } from "@walker/contracts";
import { useOnboarding, type Onboarding, type Phase } from "@/lib/useOnboarding";
import {
  countLine,
  heardSummary,
  nameOf,
  partStates,
  selectedModules,
  selectionProblems,
  suggestionNews,
  toggleModule,
  type Choices,
} from "@/lib/walker";
import { Chat, type FocusRequest } from "./Chat";
import { CheckoutButton } from "./CheckoutButton";
import { ModuleList } from "./ModuleList";
import { WalkerDiagram } from "./WalkerDiagram";
import { WalkerMark } from "./WalkerMark";
import styles from "./Demo.module.css";

/** Who is signed in, as the server saw it; null when nobody is. */
export interface AccountSummary {
  email: string | null;
}

export interface ScreenAccess {
  /** The signed-in user, or null. Signed in, the first send starts an account session; signed out, a demo. */
  account?: AccountSummary | null;
  /** The signed-in user's unfinished setup, to carry on with on this device. */
  resumeId?: string | null;
}

interface ScreenProps {
  /** The engine's first question, shown before a session exists. */
  opening: Question;
  /**
   * When the server runs the onboarding agent, the notice's clause naming who reads the answers and who
   * may keep them ("Google's Gemini reads them to choose each question, and Google may keep a copy");
   * null with the deterministic engine.
   */
  agentNotice?: string | null;
}

export function DemoScreen({ opening, agentNotice = null, account = null, resumeId = null }: ScreenProps & ScreenAccess) {
  const o = useOnboarding({ notice: account ? "account" : "demo", resumeId });
  return <DemoView o={o} opening={opening} agentNotice={agentNotice} account={account} />;
}

/** The one line under the text box that says where answers go. Sending the first answer starts on it. */
function noticeLine(agentNotice: string | null, account: AccountSummary | null): string {
  const where = account ? "Signed in: your answers are saved to your account" : "Demo: your answers are deleted here after an hour";
  const model = agentNotice ? `, and ${agentNotice}` : "";
  return `${where}${model}. Please leave out names and medical details.`;
}

/**
 * The whole demo on one page. Screen question, first: "What do you need help with?" — a guided chat on
 * the left while the walker on the right lights up what the answers suggest. Then: "Is this my
 * walker?" — the chat folds into a short summary and the walker takes the stage, where each module can
 * be opened and switched, then saved and ordered (Stripe test mode).
 */
export function DemoView({ o, opening, agentNotice = null, account = null }: { o: Onboarding } & ScreenProps & Pick<ScreenAccess, "account">) {
  const s = o.session;
  const recs = s?.recommendations ?? [];
  const review = s?.state === "review" || s?.state === "confirmed";
  const saved = s?.state === "confirmed" && s.configuration ? s.configuration : null;

  // What the person switched themselves, for this session only.
  const [choices, setChoices] = useState<Choices>({});
  const [choicesFor, setChoicesFor] = useState(s?.session_id ?? null);
  if ((s?.session_id ?? null) !== choicesFor) {
    setChoicesFor(s?.session_id ?? null);
    setChoices({});
  }

  const selected = saved ? saved.selected_module_ids : selectedModules(recs, choices);
  const states = partStates(recs, selected);
  const problems = saved ? [] : selectionProblems(selected);
  const [highlight, setHighlight] = useState<ModuleId | null>(null);
  const [saveTried, setSaveTried] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [focusRequest, setFocusRequest] = useState<FocusRequest>({ n: 0, target: "auto" });
  // Selection changes and switch results, read politely. A trailing zero-width space alternates so the
  // same sentence twice in a row is still announced.
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const announce = (text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 }));
  const walkerHeadingRef = useRef<HTMLHeadingElement>(null);
  const savedRef = useRef<HTMLParagraphElement>(null);

  // While the chat runs, say what lit up after each answer. Not on load or restore.
  const previous = useRef<{ phase: Phase; selected: ModuleId[] }>({ phase: o.phase, selected });
  useEffect(() => {
    const before = previous.current;
    previous.current = { phase: o.phase, selected };
    if (review || before.phase !== "ready" || o.phase !== "ready") return;
    const news = suggestionNews(before.selected, selected);
    if (news) announce(news);
  });

  // When the review appears, focus its heading; when the walker is saved, the confirmation. Not on load.
  const prevState = useRef(s?.state);
  useLayoutEffect(() => {
    const before = prevState.current;
    prevState.current = s?.state;
    const target =
      before === "collecting" && s?.state === "review" ? walkerHeadingRef.current : before === "review" && s?.state === "confirmed" ? savedRef.current : null;
    if (!target) return;
    // Scroll only when the target is out of sight (a phone), so a laptop screen doesn't jump.
    target.focus({ preventScroll: true });
    const box = target.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) target.scrollIntoView({ block: "start" });
  }, [s?.state]);

  function toggle(id: ModuleId, on: boolean) {
    if (saved) return announce("Your walker is saved. Start over to change it.");
    if (o.busy) return;
    const r = toggleModule(recs, choices, id, on);
    if (r.changed) setChoices(r.choices);
    announce(r.changed ? `${r.message} ${countLine(r.selected)}.` : r.message);
  }

  async function save() {
    if (o.busy || saved) return;
    setSaveTried(true);
    if (problems.length > 0) return;
    await o.confirm(selected);
  }

  async function change(questionId: QuestionId) {
    if (o.busy) return;
    if (await o.revisit(questionId)) setFocusRequest((f) => ({ n: f.n + 1, target: "auto" }));
  }

  async function startOver() {
    if (o.busy || resetting) return;
    setResetting(true);
    const ok = await o.reset();
    setResetting(false);
    if (!ok) return;
    setSaveTried(false);
    setFocusRequest((f) => ({ n: f.n + 1, target: "composer" }));
  }

  const onWalker = selected.filter((id) => id !== "base.walker").map(nameOf);
  const caption = review
    ? `On your walker: ${selected.map(nameOf).join(", ")}.`
    : onWalker.length > 0
      ? `Suggested so far: ${onWalker.join(", ")}, on the walker frame.`
      : "So far, just the walker frame. Parts light up as you answer.";
  const frozen = saved ? "Saved. Start over to change it." : o.busy ? "Saving…" : null;
  // A saved account setup is deleted from Your setups, behind a confirmation, not with one press here.
  const canReset = Boolean(s) && !(s?.kind === "account" && saved);

  return (
    <>
      <header className={styles.bar}>
        <div className={styles.barInner}>
          <span className={styles.brand}>
            <WalkerMark />
            <span>Assistive Walker</span>
          </span>
          <div className={styles.barRight}>
            <span className={styles.scope}>{account ? "Signed in" : "Prototype · demo"}</span>
            {canReset ? (
              // aria-disabled while busy, so focus stays here until the text box takes it.
              <button type="button" className="button-text" onClick={() => void startOver()} aria-disabled={o.busy || resetting || undefined}>
                {resetting ? (
                  "Starting over…"
                ) : (
                  <>
                    Start over<span className="visually-hidden"> and delete your answers</span>
                  </>
                )}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <main id="main" className={styles.main}>
        <h1 className={styles.headline}>Tell us what you need help with. We&apos;ll build your walker.</h1>
        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement.text}
          {announcement.n % 2 ? "​" : ""}
        </p>

        <div className={styles.stage} data-view={review ? "walker" : "chat"}>
          {review && s ? (
            <Heard session={s} busy={o.busy} locked={Boolean(saved)} onChange={change} />
          ) : (
            <div className={styles.chatArea}>
              <Chat o={o} opening={opening} notice={noticeLine(agentNotice, account)} focusRequest={focusRequest} />
            </div>
          )}

          <section className={styles.walker} aria-labelledby="walker-heading">
            <div className={styles.walkerHead}>
              <div>
                <h2 id="walker-heading" ref={walkerHeadingRef} tabIndex={-1} className={styles.walkerTitle}>
                  Your walker
                </h2>
                <p className={styles.walkerSub}>{review ? countLine(selected) : "Parts light up as you answer."}</p>
              </div>
              {review ? (
                saved && s ? (
                  <div className={styles.savedArea}>
                    <p ref={savedRef} tabIndex={-1} className={styles.savedLine}>
                      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                        <path d="M5 10.4l3.2 3.1L15 6.6" />
                      </svg>
                      {saved.source === "account" ? "Saved to your account." : "Saved."}
                    </p>
                    <CheckoutButton sessionId={s.session_id} configurationVersion={saved.configuration_version} />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => void save()}
                    aria-disabled={o.busy || undefined}
                    aria-describedby={saveTried && problems.length > 0 ? "save-problems" : undefined}
                  >
                    {o.busy ? "Saving…" : "Save my walker"}
                  </button>
                )
              ) : null}
            </div>

            {review && saveTried && problems.length > 0 ? (
              <div id="save-problems" role="alert" className={styles.problems}>
                <p>Before saving:</p>
                <ul>
                  {problems.map((p) => (
                    <li key={`${p.module_id}-${p.code}`}>{p.message}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {review && o.error ? (
              <p role="alert" className={styles.problems}>
                {o.error}
              </p>
            ) : null}

            <WalkerDiagram
              recs={recs}
              facts={s?.facts ?? []}
              states={states}
              review={review}
              problems={problems}
              frozen={frozen}
              onToggle={toggle}
              highlight={highlight}
              onHighlight={setHighlight}
              caption={caption}
            />
          </section>

          {review ? (
            <div className={styles.listArea}>
              <ModuleList states={states} problems={problems} frozen={frozen} onToggle={toggle} onHighlight={setHighlight} />
            </div>
          ) : null}
        </div>
      </main>
    </>
  );
}

/** The chat, folded: what was understood, grouped by question, each with a way to change that answer. */
function Heard({
  session,
  busy,
  locked,
  onChange,
}: {
  session: NonNullable<Onboarding["session"]>;
  busy: boolean;
  locked: boolean;
  onChange(questionId: QuestionId): void;
}) {
  const groups = heardSummary(session.facts, session.turns);
  return (
    <section className={styles.heard} aria-labelledby="heard-heading">
      <h2 id="heard-heading" className={styles.heardTitle}>
        Here&apos;s what I heard
      </h2>
      {groups.length === 0 ? (
        <p className={styles.heardEmpty}>You skipped the questions, so only the frame is suggested. Every module can still be switched on.</p>
      ) : (
        <ul className={styles.heardList}>
          {groups.map((g) => (
            <li key={g.questionId}>
              <ul className={styles.heardItems}>
                {g.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {locked ? null : (
                // aria-disabled while busy, so focus stays here until the reopened question takes it.
                <button type="button" className={`button-text ${styles.change}`} onClick={() => onChange(g.questionId)} aria-disabled={busy || undefined}>
                  Change<span className="visually-hidden"> your answer to “{g.prompt}”</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
