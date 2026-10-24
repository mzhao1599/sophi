"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { Question, SessionView } from "@walker/contracts";
import { DRAFT_KEY } from "./landing/CtaSentence";
import styles from "./QuestionStep.module.css";

interface Props {
  question: Question;
  previous: SessionView["current_answer"];
  progress: SessionView["progress"];
  revisiting: boolean;
  busy: boolean;
  error: string | null;
  /** Changes when a new question arrives; focus then moves to the question so it is read first. */
  focusKey: number;
  onAnswer(optionIds: string[], text: string): Promise<boolean>;
  onSkip(): void;
  onSkipRest(): void;
}

/**
 * One question at a time, set large. Options are native checkboxes or radios inside a fieldset, so
 * they work with every screen reader, switch device and keyboard without custom key handling.
 */
/** Words typed into the landing page's closing sentence, handed over once through this tab's storage. */
function readDraft(): string {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function QuestionStep({ question, previous, progress, revisiting, busy, error, focusKey, onAnswer, onSkip, onSkipRest }: Props) {
  const ids = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[]>(previous?.option_ids ?? []);
  const [text, setText] = useState(() => previous?.text ?? (question.id === "tasks" ? readDraft() : ""));
  const [localError, setLocalError] = useState<string | null>(null);
  // The draft is used once; clear it after the first render (not in the state initializer, which
  // React may run twice in development).
  useEffect(() => {
    try {
      window.sessionStorage.removeItem(DRAFT_KEY);
    } catch {
      // Storage unavailable: nothing to clear.
    }
  }, []);

  // focusKey is 0 when a saved session is restored on page load; leave focus alone then.
  useEffect(() => {
    if (focusKey > 0) headingRef.current?.focus();
  }, [focusKey]);

  const multiple = question.selection === "multiple";
  const message = localError ?? error;
  const errorId = `${ids}-error`;

  function toggle(id: string, checked: boolean) {
    setLocalError(null);
    setSelected((s) => (multiple ? (checked ? [...s, id] : s.filter((x) => x !== id)) : checked ? [id] : []));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (selected.length === 0 && !text.trim()) {
      setLocalError("Choose an option or write an answer. You can also skip this question.");
      firstInputRef.current?.focus();
      return;
    }
    await onAnswer(selected, text);
  }

  const step = Math.min(progress.answered + 1, progress.total);

  return (
    <section className={styles.step} aria-labelledby={`${ids}-heading`}>
      <div className={styles.progressRow}>
        <p className={styles.progressText}>
          {revisiting ? "Changing an earlier answer" : `Question ${step} of ${progress.total}`}
        </p>
        <div
          className={styles.track}
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.answered}
          aria-valuetext={`${progress.answered} of ${progress.total} answered`}
        >
          <div className={styles.fill} style={{ width: `${(progress.answered / progress.total) * 100}%` }} />
        </div>
      </div>

      <h1 id={`${ids}-heading`} ref={headingRef} tabIndex={-1} className={styles.prompt}>
        {question.prompt}
      </h1>
      <p id={`${ids}-detail`} className={styles.detail}>
        {question.detail}
      </p>

      <form className={styles.panel} onSubmit={submit} noValidate>
        <fieldset aria-describedby={message ? `${ids}-detail ${errorId}` : `${ids}-detail`}>
          <legend className="visually-hidden">
            {question.prompt} {multiple ? "Choose any." : "Choose one."}
          </legend>
          <p className={styles.hint} aria-hidden="true">
            {multiple ? "Choose any" : "Choose one"}
          </p>
          <div className={styles.options}>
            {question.options.map((option, i) => (
              <label key={option.id} className={styles.option}>
                <input
                  ref={i === 0 ? firstInputRef : undefined}
                  type={multiple ? "checkbox" : "radio"}
                  name={`${ids}-option`}
                  value={option.id}
                  checked={selected.includes(option.id)}
                  onChange={(e) => toggle(option.id, e.target.checked)}
                  disabled={busy}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className={styles.textField}>
          <label className="field-label" htmlFor={`${ids}-text`}>
            {question.text_label} <span className={styles.optional}>(optional)</span>
          </label>
          <textarea
            id={`${ids}-text`}
            className="textarea"
            value={text}
            maxLength={600}
            rows={3}
            onChange={(e) => {
              setLocalError(null);
              setText(e.target.value);
            }}
            aria-describedby={`${ids}-text-hint`}
            disabled={busy}
          />
          <p id={`${ids}-text-hint`} className="field-hint">
            Please leave out names, addresses and medical details. This is a demo.
          </p>
        </div>

        {message ? (
          <p id={errorId} className={styles.error} role="alert">
            {message}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? "Saving…" : "Continue"}
          </button>
          <button type="button" className="button-text" onClick={onSkip} disabled={busy}>
            Skip this question
          </button>
          {progress.answered > 0 ? (
            <button type="button" className={`button-text ${styles.skipRest}`} onClick={onSkipRest} disabled={busy}>
              Skip the rest and review
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
