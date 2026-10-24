"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import styles from "./Landing.module.css";

export const DRAFT_KEY = "walker.draft-task";

/**
 * "I'd like help with ___." The blank is the form. The words are handed to the setup through this
 * tab's sessionStorage (never the URL) and appear in the first question's text box.
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
    <form className={styles.ctaForm} onSubmit={submit} data-reveal>
      <h2 className={styles.ctaSentence}>
        <label htmlFor="cta-task">I&apos;d like help with</label>{" "}
        <input
          id="cta-task"
          className={styles.ctaInput}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="reaching the top shelf"
          maxLength={600}
          autoComplete="off"
        />{" "}
        <button type="submit" className={styles.ctaButton}>
          start
        </button>
      </h2>
      <p className={styles.ctaNote}>
        Your words go into the first question of the setup, in this browser only. Leave it blank to start from the beginning.
      </p>
    </form>
  );
}
