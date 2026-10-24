"use client";

import type { QuestionId, Turn } from "@walker/contracts";
import styles from "./Transcript.module.css";

/**
 * The whole conversation as text, so nothing said is only visible for a moment. The latest answer
 * to each question can be changed from here.
 */
export function Transcript({ turns, canChange, busy, onChange }: { turns: Turn[]; canChange: boolean; busy: boolean; onChange(q: QuestionId): void }) {
  const latestAnswer = new Map<QuestionId, string>();
  for (const t of turns) if (t.role === "user" && t.question_id) latestAnswer.set(t.question_id, t.id);

  return (
    <details className={styles.transcript}>
      <summary className={styles.summary}>
        Conversation so far <span className={styles.count}>({turns.length} messages)</span>
      </summary>
      <ol className={styles.list}>
        {turns.map((t) => (
          <li key={t.id} className={t.role === "user" ? styles.user : styles.assistant}>
            <span className={styles.who}>{t.role === "user" ? "You" : "Assistant"}</span>
            <p className={styles.text}>{t.text}</p>
            {/* aria-disabled while busy, so focus stays here until the reopened question's heading takes it. */}
            {canChange && t.role === "user" && t.question_id && latestAnswer.get(t.question_id) === t.id ? (
              <button
                type="button"
                className="button-text"
                onClick={() => {
                  if (!busy) onChange(t.question_id!);
                }}
                aria-disabled={busy || undefined}
              >
                Change this answer
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
