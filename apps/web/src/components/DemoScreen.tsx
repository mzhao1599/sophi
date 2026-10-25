"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModuleId, Question } from "@walker/contracts";
import { PRODUCT_LINE, PRODUCT_NAME } from "@/lib/brand";
import { demoPriceLine } from "@/lib/checkout";
import { surge, useReducedMotion } from "@/lib/motion";
import { useOnboarding, type Onboarding, type Phase } from "@/lib/useOnboarding";
import {
  countLine,
  nameOf,
  partStates,
  selectedModules,
  selectionProblems,
  suggestionNews,
  toggleModule,
  type Choices,
  type PartState,
} from "@/lib/walker";
import { noticeLine } from "@/lib/chat";
import { Chat, type FocusRequest } from "./Chat";
import { CheckoutButton } from "./CheckoutButton";
import { ContourField } from "./ContourField";
import { Intro } from "./Intro";
import { ModuleList } from "./ModuleList";
import { Legend, WalkerDiagram } from "./WalkerDiagram";
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
   * may keep them ("Anthropic's Claude reads your answers to choose each question, and Anthropic may keep a copy");
   * null with the deterministic engine.
   */
  agentNotice?: string | null;
  /** The model's short name while the agent runs ("Claude"), for the note under each reply; null otherwise. */
  agentName?: string | null;
}

/** How long the final message has to be read before the walker rises. */
const SHEET_DELAY_MS = 1200;

export function DemoScreen({ opening, agentNotice = null, agentName = null, account = null, resumeId = null }: ScreenProps & ScreenAccess) {
  const o = useOnboarding({ notice: account ? "account" : "demo", resumeId });
  return (
    <>
      <Intro />
      <DemoView o={o} opening={opening} agentNotice={agentNotice} agentName={agentName} account={account} />
    </>
  );
}

const FIRST_FRAME = "Your walker starts as just the frame. Tell us what's hard.";

/** What the drawing shows while the conversation runs, in words, for screen readers. */
function chatCaption(states: Record<ModuleId, PartState>): string {
  const named = (state: PartState) =>
    (Object.keys(states) as ModuleId[]).filter((id) => id !== "base.walker" && states[id] === state).map(nameOf);
  const parts = [
    ["Suggested", named("on")],
    ["Worth considering", named("suggested")],
    ["You said no to", named("declined")],
  ] as const;
  const said = parts.filter(([, names]) => names.length > 0).map(([lead, names]) => `${lead}: ${names.join(", ")}.`);
  return said.length > 0 ? said.join(" ") : FIRST_FRAME;
}

/**
 * The whole demo on one page. First a conversation with the onboarding assistant, while the walker
 * beside it draws in what the answers suggest. When the assistant has enough, the walker rises to the
 * middle as a sheet: each module can be opened and switched, then saved and ordered (Stripe test mode).
 */
export function DemoView({ o, opening, agentNotice = null, agentName = null, account = null }: { o: Onboarding } & ScreenProps & Pick<ScreenAccess, "account">) {
  const s = o.session;
  const recs = s?.recommendations ?? [];
  const review = s?.state === "review" || s?.state === "confirmed";
  const saved = s?.state === "confirmed" && s.configuration ? s.configuration : null;
  const reduced = useReducedMotion();

  // What the person switched themselves, for this session only.
  const [choices, setChoices] = useState<Choices>({});
  const [choicesFor, setChoicesFor] = useState(s?.session_id ?? null);
  if ((s?.session_id ?? null) !== choicesFor) {
    setChoicesFor(s?.session_id ?? null);
    setChoices({});
  }

  const selected = saved ? saved.selected_module_ids : selectedModules(recs, choices);
  const states = partStates(recs, selected, s?.facts ?? []);
  const problems = saved ? [] : selectionProblems(selected);
  const [highlight, setHighlight] = useState<ModuleId | null>(null);
  const [saveTried, setSaveTried] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [focusRequest, setFocusRequest] = useState<FocusRequest>({ n: 0 });
  // Selection changes and switch results, read politely. A trailing zero-width space alternates so the
  // same sentence twice in a row is still announced.
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const announce = (text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 }));
  const sheetHeadingRef = useRef<HTMLHeadingElement>(null);
  const savedRef = useRef<HTMLParagraphElement>(null);

  // The sheet rises a moment after the conversation ends (so its last message can be read), or at
  // once when a finished session is loaded. It goes when the session does.
  const [sheet, setSheet] = useState<"down" | "rising" | "up">("down");
  const prevState = useRef(s?.state);
  const rose = useRef(false);
  useEffect(() => {
    const before = prevState.current;
    prevState.current = s?.state;
    if (!review) setSheet("down");
    else setSheet((current) => (current !== "down" ? current : before === "collecting" ? "rising" : "up"));
  }, [review, s?.state]);
  useEffect(() => {
    if (sheet !== "rising") return;
    const t = window.setTimeout(() => {
      rose.current = true;
      setSheet("up");
    }, reduced ? 0 : SHEET_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [sheet, reduced]);

  // When the sheet rises after the conversation, focus its heading and let the background move.
  useLayoutEffect(() => {
    if (sheet !== "up") return;
    surge();
    if (rose.current) {
      rose.current = false;
      sheetHeadingRef.current?.focus({ preventScroll: true });
    }
  }, [sheet]);

  // After Save, focus the confirmation.
  const prevSaved = useRef(Boolean(saved));
  useLayoutEffect(() => {
    if (!prevSaved.current && saved) savedRef.current?.focus({ preventScroll: true });
    prevSaved.current = Boolean(saved);
  }, [saved]);

  // While the conversation runs, say what lit up after each answer. Not on load or restore.
  const previous = useRef<{ phase: Phase; selected: ModuleId[] }>({ phase: o.phase, selected });
  useEffect(() => {
    const before = previous.current;
    previous.current = { phase: o.phase, selected };
    if (review || before.phase !== "ready" || o.phase !== "ready") return;
    const news = suggestionNews(before.selected, selected);
    if (news) announce(news);
  });

  function toggle(id: ModuleId, on: boolean) {
    if (saved) return announce("Your walker is saved. Start over to change it.");
    if (o.busy) return;
    const r = toggleModule(recs, choices, id, on);
    if (r.changed) setChoices(r.choices);
    // The price line beside the heading changes too, so it is read out with the count.
    announce(r.changed ? `${r.message} ${countLine(r.selected)}, ${demoPriceLine(r.selected)}.` : r.message);
  }

  async function save() {
    if (o.busy || saved) return;
    setSaveTried(true);
    if (problems.length > 0) return;
    if (await o.confirm(selected)) announce(`Saved. ${countLine(selected)}.`);
  }

  async function startOver() {
    if (o.busy || resetting) return;
    setResetting(true);
    const ok = await o.reset();
    setResetting(false);
    if (!ok) return;
    setSaveTried(false);
    surge();
    setFocusRequest((f) => ({ n: f.n + 1 }));
  }

  const caption = review ? `On your walker: ${selected.map(nameOf).join(", ")}.` : chatCaption(states);
  // The first frame explains itself before anyone speaks; once parts light up, a key says what their lines mean.
  const note = review ? null : chatCaption(states) === FIRST_FRAME ? <p className={styles.firstLine}>{FIRST_FRAME}</p> : <Legend states={states} />;
  const frozen = saved ? "Saved. Start over to change it." : o.busy && review ? "Saving." : null;
  // A saved account setup is deleted from Your setups, behind a confirmation, not with one press here.
  const canReset = Boolean(s) && !(s?.kind === "account" && saved);
  const sheetUp = sheet === "up" && review && s;
  const saveLabel = o.busy ? "Saving" : "Save";

  return (
    <>
      <ContourField />
      <header className={styles.bar}>
        <span className={styles.brand}>
          <WalkerMark size={24} />
          <span className={styles.wordmark}>{PRODUCT_NAME}</span>
          <span className={styles.line}>{PRODUCT_LINE}</span>
        </span>
        <div className={styles.barRight}>
          {account ? <span className={styles.scope}>Signed In</span> : null}
          {canReset ? (
            // aria-disabled while busy, so focus stays here until the text box takes it.
            <button type="button" className={styles.barButton} onClick={() => void startOver()} aria-disabled={o.busy || resetting || undefined}>
              <span key={resetting ? "a" : "b"} className="fade-text">
                {resetting ? "Starting Over" : "Start Over"}
              </span>
              <span className="visually-hidden"> and delete your answers</span>
            </button>
          ) : null}
        </div>
      </header>

      <main id="main" className={styles.main}>
        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement.text}
          {announcement.n % 2 ? "​" : ""}
        </p>

        {/* Behind the sheet once it rises: receded, and out of reach of the keyboard and screen readers. */}
        <div className={styles.scene} data-receded={sheetUp ? "true" : undefined} inert={Boolean(sheetUp)}>
          <section className={styles.talk} aria-labelledby="headline">
            <h1 id="headline" className={styles.headline}>
              Let&apos;s build your walker.
            </h1>
            <Chat o={o} opening={opening} focusRequest={focusRequest} notice={noticeLine(agentNotice, account !== null)} describedBy="notice" agentName={agentName} />
          </section>
          <div className={styles.preview}>
            <WalkerDiagram
              recs={recs}
              facts={s?.facts ?? []}
              states={states}
              review={false}
              problems={[]}
              frozen={null}
              onToggle={toggle}
              highlight={null}
              onHighlight={() => undefined}
              caption={caption}
              note={note}
              view="front"
            />
          </div>
        </div>

        {sheetUp ? (
          <div className={styles.sheetLayer}>
            <section className={styles.sheet} aria-labelledby="walker-heading">
              <div className={styles.sheetHead}>
                <div>
                  <h2 id="walker-heading" ref={sheetHeadingRef} tabIndex={-1} className={styles.sheetTitle}>
                    Your walker
                  </h2>
                  <p className={styles.sheetMeta}>
                    {selected.length} {selected.length === 1 ? "module" : "modules"} · {demoPriceLine(selected)}
                  </p>
                </div>
                {saved ? (
                  <div className={styles.savedArea}>
                    <p ref={savedRef} tabIndex={-1} className={styles.savedLine}>
                      <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                        <path d="M5 10.4l3.2 3.1L15 6.6" />
                      </svg>
                      Saved
                    </p>
                    <CheckoutButton sessionId={s.session_id} configurationVersion={saved.configuration_version} />
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`button button-primary ${styles.save}`}
                    onClick={() => void save()}
                    aria-disabled={o.busy || undefined}
                    aria-describedby={saveTried && problems.length > 0 ? "save-problems" : undefined}
                  >
                    <span key={saveLabel} className="fade-text">
                      {saveLabel}
                    </span>
                  </button>
                )}
              </div>

              {saveTried && problems.length > 0 ? (
                <div id="save-problems" role="alert" className={styles.problems}>
                  {problems.map((p) => (
                    <p key={`${p.module_id}-${p.code}`}>{p.message}</p>
                  ))}
                </div>
              ) : null}
              {o.error ? (
                <p role="alert" className={styles.problems}>
                  {o.error}
                </p>
              ) : null}

              <div className={styles.sheetBody}>
                <WalkerDiagram
                  recs={recs}
                  facts={s.facts}
                  states={states}
                  review
                  problems={problems}
                  frozen={frozen}
                  onToggle={toggle}
                  highlight={highlight}
                  onHighlight={setHighlight}
                  caption={caption}
                  view="side"
                />
                <ModuleList states={states} problems={problems} frozen={frozen} onToggle={toggle} onHighlight={setHighlight} />
              </div>
            </section>
          </div>
        ) : null}
      </main>
    </>
  );
}
