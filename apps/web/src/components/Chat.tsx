"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Question, SessionView } from "@walker/contracts";
import { chatMessages, inQuestionOrder, replyText } from "@/lib/chat";
import type { Onboarding } from "@/lib/useOnboarding";
import styles from "./Demo.module.css";

export interface FocusRequest {
  n: number;
  /** auto: the first option if the question has any, else the text box. composer: the text box. */
  target: "auto" | "composer";
}

const userTurns = (s: SessionView | null) => (s ? s.turns.filter((t) => t.role === "user").length : 0);

/**
 * The guided chat. The log is the session's own turns; the composer offers the current question's
 * options as buttons and always has a text box. The session starts on the first send: the data notice
 * sits under the box, so it has been on screen before anything is sent.
 *
 * Focus: nothing here moves focus on its own except after the person's own action. When a reply comes
 * back, focus stays in the text box if it was there; otherwise it goes to the first option (or the box),
 * because the pressed button was replaced. It never moves when focus has gone elsewhere meanwhile.
 */
export function Chat({ o, opening, notice, focusRequest }: { o: Onboarding; opening: Question; notice: string; focusRequest: FocusRequest }) {
  const s = o.session;
  const question: Question | null = s ? s.current_question : o.phase === "none" ? opening : null;
  const questionKey = s ? `${question?.id}-${s.turns.length}` : "opening";
  const multiple = question?.selection === "multiple";

  const ids = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const [pickedFor, setPickedFor] = useState(questionKey);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<{ text: string; userTurns: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const firstChipRef = useRef<HTMLButtonElement>(null);

  // A new question starts with nothing chosen, or with the earlier answer when it is being changed.
  if (pickedFor !== questionKey) {
    setPickedFor(questionKey);
    setPicked(s?.current_answer?.option_ids ?? []);
  }

  // The bubble for what was just sent shows until the server has recorded it, then the recorded turn
  // takes its place (in the same render, so it never shows twice).
  const shownPending = pending && userTurns(s) === pending.userTurns ? pending.text : null;
  const messages = o.phase === "loading" ? [] : chatMessages(s?.turns ?? null, opening, shownPending);
  const lastQuestion = messages.findLastIndex((m) => m.kind === "question");
  const sending = pending !== null;
  const error = localError ?? o.error;
  const errorId = `${ids}-error`;
  const noticeId = `${ids}-notice`;
  const textId = `${ids}-text`;

  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    log.scrollTo({ top: log.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, [messages.length, sending]);

  useLayoutEffect(() => {
    if (focusTick === 0) return;
    const active = document.activeElement;
    if (active === textRef.current) return;
    if (active && active !== document.body && !composerRef.current?.contains(active)) return;
    (firstChipRef.current ?? textRef.current)?.focus({ preventScroll: true });
  }, [focusTick]);

  useLayoutEffect(() => {
    if (focusRequest.n === 0) return;
    const target = focusRequest.target === "composer" ? textRef.current : (firstChipRef.current ?? textRef.current);
    target?.focus({ preventScroll: true });
  }, [focusRequest]);

  /**
   * Runs one action with the reply bubble shown meanwhile, then places focus (see above). If it failed,
   * focus stays on the pressed control so it can be tried again, unless that control is gone.
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

  async function send(optionIds: string[], words: string) {
    if (sending || o.busy || !question) return;
    const chosen = inQuestionOrder(question, optionIds);
    if (chosen.length === 0 && !words.trim()) {
      setLocalError("Type an answer, or choose one of the options.");
      textRef.current?.focus();
      return;
    }
    const reply = replyText(question, chosen, words);
    setText("");
    setPicked([]);
    const ok = await act(reply, async () => {
      if (s) return o.answer(question.id, chosen, words);
      const started = await o.start();
      const first = started?.current_question;
      if (!first) return false;
      // The opening question is the engine's own first question; if that ever differs, send the words.
      return first.id === question.id ? o.answer(first.id, chosen, words) : o.answer(first.id, [], reply);
    });
    if (!ok) {
      setText(words);
      setPicked(chosen);
    }
  }

  async function skip() {
    if (sending || o.busy || !question) return;
    await act("Skipped", async () => {
      if (s) return o.skip(question.id);
      const first = (await o.start())?.current_question;
      return first ? o.skip(first.id) : false;
    });
  }

  async function skipRest() {
    if (sending || o.busy || !s) return;
    await act("Skip the rest of the questions", o.skipRest);
  }

  function onTextKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section className={styles.chat} aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="visually-hidden">
        Conversation
      </h2>
      <div ref={logRef} className={styles.log} role="log" aria-label="Conversation" tabIndex={0}>
        {o.phase === "none" && o.status ? <p className={styles.system}>{o.status}</p> : null}
        {o.phase === "loading" ? <p className={styles.system}>Loading your conversation…</p> : null}
        {messages.map((m, i) =>
          m.kind === "note" ? (
            <p key={m.key} className={styles.note}>
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <path d="M5 10.4l3.2 3.1L15 6.6" />
              </svg>
              {m.text}
            </p>
          ) : (
            <div key={m.key} className={styles.bubble} data-role={m.role}>
              <span className="visually-hidden">{m.role === "user" ? "You: " : "Assistant: "}</span>
              <p>{m.text}</p>
              {i === lastQuestion && question && m.questionId === question.id ? <p className={styles.detail}>{question.detail}</p> : null}
            </div>
          ),
        )}
        {sending ? (
          <div className={styles.typing} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>

      <div ref={composerRef} className={styles.composer}>
        {question && question.options.length > 0 ? (
          <fieldset key={questionKey} className={styles.chips} aria-describedby={error ? errorId : undefined}>
            <legend className="visually-hidden">
              {question.prompt} {multiple ? "Choose any, then press Send." : "Choose one to send it."}
            </legend>
            <p className={styles.chipHint} aria-hidden="true">
              {multiple ? "Choose any, then Send" : "Tap one to answer"}
            </p>
            <div className={styles.chipRow}>
              {question.options.map((option, i) =>
                multiple ? (
                  <button
                    key={option.id}
                    ref={i === 0 ? firstChipRef : undefined}
                    type="button"
                    className={styles.chip}
                    aria-pressed={picked.includes(option.id)}
                    aria-disabled={sending || undefined}
                    onClick={() => {
                      if (sending) return;
                      setLocalError(null);
                      setPicked((p) => (p.includes(option.id) ? p.filter((x) => x !== option.id) : [...p, option.id]));
                    }}
                  >
                    <svg className={styles.chipMark} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                      <rect x="2.5" y="2.5" width="15" height="15" rx="4" />
                      <path d="M6 10.4l2.6 2.6L14 7.6" />
                    </svg>
                    {option.label}
                  </button>
                ) : (
                  <button
                    key={option.id}
                    ref={i === 0 ? firstChipRef : undefined}
                    type="button"
                    className={styles.chip}
                    data-selected={picked.includes(option.id) || undefined}
                    aria-disabled={sending || undefined}
                    onClick={() => void send([option.id], text)}
                  >
                    {option.label}
                  </button>
                ),
              )}
            </div>
          </fieldset>
        ) : null}

        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void send(picked, text);
          }}
          noValidate
        >
          <label htmlFor={textId} className={styles.textLabel}>
            {question?.text_label ?? "Your answer"}
          </label>
          <div className={styles.inputRow}>
            <textarea
              id={textId}
              ref={textRef}
              className={`textarea ${styles.text}`}
              rows={2}
              value={text}
              maxLength={600}
              placeholder={question?.id === opening.id ? "For example: I keep bumping into door frames" : undefined}
              onChange={(e) => {
                setLocalError(null);
                setText(e.target.value);
              }}
              onKeyDown={onTextKey}
              aria-describedby={error ? `${noticeId} ${errorId}` : noticeId}
              aria-invalid={localError ? true : undefined}
            />
            <button type="submit" className={`button button-primary ${styles.send}`} aria-disabled={sending || !question || undefined}>
              {sending ? "Sending…" : multiple && picked.length > 0 ? `Send ${picked.length}` : "Send"}
            </button>
          </div>
        </form>

        {error ? (
          <p id={errorId} className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={styles.composerFoot}>
          <p id={noticeId} className={styles.notice}>
            {notice}
          </p>
          <div className={styles.skips}>
            {question ? (
              <button type="button" className={`button-text ${styles.skip}`} onClick={() => void skip()} aria-disabled={sending || undefined}>
                Skip this question
              </button>
            ) : null}
            {s && s.progress.answered > 0 ? (
              <button type="button" className={`button-text ${styles.skip}`} onClick={() => void skipRest()} aria-disabled={sending || undefined}>
                Skip to my walker
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
