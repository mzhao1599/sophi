"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "./Landing.module.css";

export const DRAFT_KEY = "walker.draft-task";

/**
 * The closing question, with two answers: start with a few words of your own, or start from the
 * first question. The words are handed to the setup through this tab's sessionStorage (never the
 * URL) and appear in the first question's text box.
 */
export function CtaSentence() {
  const router = useRouter();
  const [text, setText] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (text.trim()) window.sessionStorage.setItem(DRAFT_KEY, text.trim().slice(0, 600));
    } catch {
      // Storage can be unavailable in private windows; the setup still starts, just without the words.
    }
    router.push("/onboarding");
  }

  return (
    <section className={styles.cta} aria-labelledby="cta-heading">
      {/* The question is read once, whole; its second line is shown again under the form, at the bottom edge. */}
      <h2 id="cta-heading" className={styles.ctaQuestion}>
        What would you<span className="visually-hidden"> like help with?</span>
      </h2>
      <form className={styles.ctaForm} onSubmit={submit}>
        <label className={styles.ctaLabel} htmlFor="cta-task">
          In a few words (optional)
        </label>
        <input
          id="cta-task"
          className={styles.ctaInput}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="reaching the top shelf"
          maxLength={600}
          autoComplete="off"
          aria-describedby="cta-note"
        />
        <div className={styles.ctaChoices}>
          <button type="submit" className={styles.action}>
            Start with my words
          </button>
          <span className={styles.ctaOr}>or</span>
          <Link href="/onboarding" className={styles.actionAlt}>
            Start from the first question
          </Link>
        </div>
        <p id="cta-note" className={styles.ctaNote}>
          Your words go into the first question of the setup, in this browser only.
        </p>
      </form>
      <p className={styles.ctaEcho} aria-hidden="true">
        like help with?
      </p>
    </section>
  );
}
