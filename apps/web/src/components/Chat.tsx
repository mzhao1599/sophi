"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { Question, SessionView } from "@walker/contracts";
import { SKIP_REPLY, SKIP_REST_REPLY, chatMessages, quickReplies, revealDelay, words, type ChatMessage } from "@/lib/chat";
import { surge, useReducedMotion } from "@/lib/motion";
import type { Onboarding } from "@/lib/useOnboarding";
import styles from "./Demo.module.css";

export interface FocusRequest {
  n: number;
}

const userTurns = (s: SessionView | null) => (s ? s.turns.filter((t) => t.role === "user").length : 0);

/**
 * The assistant's mark: a small green ring beside what it says. It is "live" beside the newest
 * message and breathes while a reply is on its way; older messages keep a quiet dot.
 */
export function Mark({ state }: { state: "live" | "thinking" | "past" }) {
  return <span className={styles.mark} data-state={state} aria-hidden="true" />;
}

/** A new agent message rises in word by word; an old one (or any, under reduced motion) is just text. */
export function Words({ text, animate }: { text: string; animate: boolean }) {
  if (!animate) return <>{text}</>;
  const list = words(text);
  return (
    <>
      {list.map((w, i) => (
        <Fragment key={i}>
          <span className={styles.word} style={{ animationDelay: `${revealDelay(i, list.length)}ms` }}>
            {w}
          </span>
          {i < list.length - 1 ? " " : null}
        </Fragment>
      ))}
    </>
  );
}

/**
 * The conversation. The log is the session's own turns, one message per reply: the assistant's words
 * as plain text beside its mark, yours as quiet pills. Typing is the main way to answer; up to three
 * of the current question's options sit above the box as "for example" replies, and a tap sends one
 * as your message. The session starts on the first send: the data notice (described by
 * `describedBy`) is on screen before that.
 *
 * Focus moves only after the person's own action. When a reply comes back, focus stays in the text box
 * if it was there; if a quick reply was tapped (and so replaced), the text box takes it. It never moves
 * when focus has gone elsewhere meanwhile.
 */
export function Chat({
  o,
  opening,
  focusRequest,
  notice,
  describedBy,
  agentName = null,
}: {
  o: Onboarding;
  opening: Question;
  focusRequest: FocusRequest;
  /** The data notice, shown under the box before anything is sent; `describedBy` is its id. */
  notice: string;
  describedBy: string;
  /** While the agent runs, its short name ("Claude"): each reply then says who answered it. */
  agentName?: string | null;
}) {
  const s = o.session;
  const question: Question | null = s ? s.current_question : o.phase === "none" ? opening : null;
  const questionKey = s ? `${question?.id}-${s.turns.length}` : "opening";
  const reduced = useReducedMotion();

  const ids = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ text: string; userTurns: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  // Messages from before this page load (a restored session) don't replay their reveal. A conversation
  // that starts again (Start Over, or an expired session) gets a new generation, so its first message
  // is a new node and reveals again.
  const [baseline, setBaseline] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const [lastPhase, setLastPhase] = useState(o.phase);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const shownPending = pending && userTurns(s) === pending.userTurns ? pending.text : null;
  const messages: ChatMessage[] = o.phase === "loading" ? [] : chatMessages(s?.turns ?? null, opening, shownPending);
  if (o.phase !== lastPhase) {
    setLastPhase(o.phase);
    if (lastPhase === "ready" && o.phase === "none") {
      setGeneration((g) => g + 1);
      setBaseline(0);
    }
  }
  if (baseline === null && o.phase !== "loading") setBaseline(o.phase === "none" ? 0 : messages.length);

  const sending = pending !== null;
  const error = localError ?? o.error;
  const errorId = `${ids}-error`;
  const replies = quickReplies(question);
  const last = messages.at(-1);
  const lastAgent = messages.findLastIndex((m) => m.role === "assistant");

  // Keep the newest message in view, and let the world move a little when the agent speaks.
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTo({ top: log.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [messages.length, sending, reduced]);
  useEffect(() => {
    if (last?.role === "assistant" && baseline !== null && messages.length > baseline) surge();
  }, [last?.key, last?.role, baseline, messages.length]);

  useLayoutEffect(() => {
    if (focusTick === 0) return;
    const active = document.activeElement;
    if (active === inputRef.current) return;
    if (active && active !== document.body && !composerRef.current?.contains(active)) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [focusTick]);

  useLayoutEffect(() => {
    if (focusRequest.n > 0) inputRef.current?.focus({ preventScroll: true });
  }, [focusRequest]);

  /**
   * Runs one action with the person's reply shown meanwhile, then places focus (see above). If it
   * failed, focus stays on the pressed control so it can be tried again, unless that control is gone.
   */
  async function act(shown: string, action: () => Promise<boolean>): Promise<boolean> {
    setLocalError(null);
    o.clearError();
    setPending({ text: shown, userTurns: userTurns(s) });
    const ok = await action();
    setPending(null);
    if (ok || !composerRef.current?.contains(document.activeElement)) setFocusTick((t) => t + 1);
    return ok;
  }

  /** Answers the current question: one tapped option, or typed words. Starts the session first if needed. */
  async function send(optionIds: string[], words: string, shown: string) {
    if (sending || o.busy || !question) return;
    if (optionIds.length === 0 && !words.trim()) return;
    if (!optionIds.length) setText("");
    const ok = await act(shown, async () => {
      if (s) return o.answer(question.id, optionIds, words);
      const first = (await o.start())?.current_question;
      if (!first) return false;
      // The opening question is the engine's own first question; if that ever differs, send the words.
      return first.id === question.id ? o.answer(first.id, optionIds, words) : o.answer(first.id, [], shown);
    });
    if (!ok && !optionIds.length) setText(words);
  }

  async function skip() {
    if (sending || o.busy || !question) return;
    await act(SKIP_REPLY, async () => {
      if (s) return o.skip(question.id);
      const first = (await o.start())?.current_question;
      return first ? o.skip(first.id) : false;
    });
  }

  async function showWalker() {
    if (sending || o.busy || !s) return;
    await act(SKIP_REST_REPLY, o.skipRest);
  }

  const canSend = Boolean(text.trim()) && !sending && Boolean(question);

  return (
    <div className={styles.chat}>
      <div ref={logRef} className={styles.log} role="log" aria-label="Conversation" tabIndex={0}>
        {o.phase === "loading" ? <p className={styles.system}>Loading</p> : null}
        {o.phase === "none" && o.status && generation > 0 ? <p className={styles.system}>{o.status}</p> : null}
        {messages.map((m, i) =>
          m.role === "assistant" ? (
            <div key={`${generation}-${m.key}`} className={styles.said}>
              <Mark state={i === lastAgent ? (sending ? "past" : "live") : "past"} />
              <p className={styles.saidText}>
                <span className="visually-hidden">Assistant: </span>
                <Words text={m.text} animate={!reduced && baseline !== null && i >= baseline} />
              </p>
              {agentName && m.answeredBy ? (
                <p className={styles.engine} data-by={m.answeredBy}>
                  {m.answeredBy === "model" ? `Read by ${agentName}` : "Fixed questions: the model's reply didn't come through"}
                </p>
              ) : null}
            </div>
          ) : (
            <div key={`${generation}-${m.key}`} className={styles.reply}>
              <p>
                <span className="visually-hidden">You: </span>
                {m.text}
              </p>
            </div>
          ),
        )}
        {sending ? (
          <div className={`${styles.said} ${styles.thinking}`} aria-hidden="true">
            <Mark state="thinking" />
            <span className={styles.dots}>
              <span />
              <span />
              <span />
            </span>
          </div>
        ) : null}
      </div>

      <div ref={composerRef} className={styles.composer}>
        {question ? (
          // Kept while a reply is sending (aria-disabled), so a tapped one keeps focus until the answer.
          <div key={questionKey} className={styles.examples} role="group" aria-labelledby={`${ids}-examples`}>
            <span id={`${ids}-examples`} className={styles.examplesLabel}>
              For example
            </span>
            {replies.map((option) => (
              <button
                key={option.id}
                type="button"
                className={styles.example}
                aria-disabled={sending || undefined}
                onClick={() => void send([option.id], "", option.label)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}

        <form
          className={styles.inputPill}
          onSubmit={(e) => {
            e.preventDefault();
            if (canSend) void send([], text, text.trim());
          }}
          noValidate
        >
          <label htmlFor={`${ids}-input`} className="visually-hidden">
            Your reply
          </label>
          <input
            id={`${ids}-input`}
            ref={inputRef}
            className={styles.input}
            type="text"
            value={text}
            maxLength={600}
            autoComplete="off"
            placeholder={s ? "Type a reply" : "For example: small buttons are hard for me"}
            onChange={(e) => {
              setLocalError(null);
              setText(e.target.value);
            }}
            aria-describedby={[notice ? describedBy : null, error ? errorId : null].filter(Boolean).join(" ") || undefined}
          />
          <button type="submit" className={styles.sendButton} aria-label="Send" aria-disabled={!canSend || undefined}>
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M10 15.5V4.5M5 9.5l5-5 5 5" />
            </svg>
          </button>
        </form>

        {error ? (
          <p id={errorId} className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.foot}>
          {notice ? (
            <p id={describedBy} className={styles.notice}>
              {notice}
            </p>
          ) : null}
          {question ? (
            <div className={styles.quiet}>
              <button type="button" className={styles.quietButton} aria-disabled={sending || undefined} onClick={() => void skip()}>
                Skip
              </button>
              {s && s.progress.answered >= 2 ? (
                <button type="button" className={styles.quietButton} aria-disabled={sending || undefined} onClick={() => void showWalker()}>
                  Show My Walker
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
