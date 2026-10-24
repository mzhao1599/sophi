"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { deleteAccount, deleteSetup } from "@/server/auth-actions";
import styles from "./Account.module.css";

export interface SetupSummary {
  session_id: string;
  version: number;
  confirmed_at: string;
  modules: string[];
}

function when(iso: string) {
  return new Date(iso).toLocaleString([], { dateStyle: "long", timeStyle: "short" });
}

/** After "Keep it", focus goes back to the button that asked, which is rendered again by then. */
function refocus(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/**
 * The second step of a delete: the question, the button that deletes, and one that keeps it. Focus
 * moves to the delete button when the question appears.
 */
function ConfirmDelete({
  id,
  question,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  id: string;
  question: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div role="group" aria-labelledby={id} className={styles.actions}>
      <p id={id}>{question}</p>
      {/* aria-disabled while deleting, so focus stays on the button; a press then is ignored. */}
      <button
        ref={confirmRef}
        type="button"
        className="button button-secondary button-danger"
        aria-disabled={pending || undefined}
        onClick={() => {
          if (!pending) onConfirm();
        }}
      >
        {pending ? "Deleting…" : confirmLabel}
      </button>
      <button
        type="button"
        className="button-text"
        aria-disabled={pending || undefined}
        onClick={() => {
          if (!pending) onCancel();
        }}
      >
        Keep it
      </button>
    </div>
  );
}

/**
 * A signed-in user's saved setups, newest first, each with a two-step delete. After a delete, focus
 * goes to the list's heading and the result is announced.
 */
export function SetupsList({ setups }: { setups: SetupSummary[] }) {
  const [items, setItems] = useState(setups);
  const [asking, setAsking] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [pending, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement>(null);

  return (
    <section aria-labelledby="setups-heading" className={styles.panel}>
      <h2 id="setups-heading" ref={headingRef} tabIndex={-1} className={`${styles.heading} ${styles.focusTarget}`}>
        Saved setups
      </h2>
      <p role="status" className={styles.notice}>
        {status}
      </p>
      {items.length === 0 ? (
        <p className={styles.meta}>No saved setups yet. When you confirm a setup while signed in, it appears here.</p>
      ) : (
        <ul className={styles.list}>
          {items.map((s) => (
            <li key={s.session_id} className={styles.setup}>
              <h3 className={styles.heading}>Setup {s.version}</h3>
              <p className={styles.meta}>
                Saved{" "}
                <time dateTime={s.confirmed_at} suppressHydrationWarning>
                  {when(s.confirmed_at)}
                </time>
              </p>
              <p>{s.modules.join(", ")}</p>
              {asking === s.session_id ? (
                <ConfirmDelete
                  id={`ask-${s.session_id}`}
                  question={`Delete setup ${s.version} and the answers it came from? This can't be undone.`}
                  confirmLabel={`Yes, delete setup ${s.version}`}
                  pending={pending}
                  onCancel={() => {
                    setAsking(null);
                    refocus(`delete-${s.session_id}`);
                  }}
                  onConfirm={() =>
                    startTransition(async () => {
                      const result = await deleteSetup(s.session_id);
                      setStatus(result.message);
                      if (!result.ok) return;
                      setItems((all) => all.filter((x) => x.session_id !== s.session_id));
                      setAsking(null);
                      headingRef.current?.focus();
                    })
                  }
                />
              ) : (
                <div className={styles.actions}>
                  <button id={`delete-${s.session_id}`} type="button" className="button-text button-danger" onClick={() => setAsking(s.session_id)}>
                    Delete setup {s.version}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Deletes the account, after the same two-step confirmation. */
export function DeleteAccount() {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <>
      {asking ? (
        <ConfirmDelete
          id="ask-account"
          question="Delete your account, with every saved setup and answer in it? This can't be undone."
          confirmLabel="Yes, delete my account"
          pending={pending}
          onCancel={() => {
            setAsking(false);
            refocus("delete-account");
          }}
          onConfirm={() =>
            startTransition(async () => {
              const result = await deleteAccount();
              if (!result.ok) setError(result.message);
            })
          }
        />
      ) : (
        <button id="delete-account" type="button" className="button-text button-danger" onClick={() => setAsking(true)}>
          Delete my account
        </button>
      )}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </>
  );
}
