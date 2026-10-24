"use client";

import { useId, useRef, useState } from "react";
import { MODULE_CATALOG, NEED_TAG_LABELS, getCatalogEntry, type ProfileFact, type Recommendation } from "@walker/contracts";
import styles from "./FactsPanel.module.css";

interface Props {
  facts: ProfileFact[];
  recommendations?: Recommendation[];
  editable: boolean;
  busy: boolean;
  onUpdate(factId: string, text: string): Promise<boolean>;
  onRemove(factId: string, text: string): Promise<void>;
}

// Chosen options are shown as plain statements; the user's own words are quoted and labelled.
const SOURCE: Record<ProfileFact["source"], string> = {
  chosen: "You chose this",
  typed: "In your words",
  edited: "You edited this",
};

function inference(fact: ProfileFact): string {
  // A chosen option already says what it means; only the user's own words need the reading spelled out.
  if (fact.source === "chosen") return "";
  const parts: string[] = [];
  if (fact.tags.length > 0) parts.push(`I took this as ${fact.tags.map((t) => NEED_TAG_LABELS[t]).join(", ")}`);
  if (fact.declined_tags.length > 0) parts.push(`you don't want ${fact.declined_tags.map((t) => NEED_TAG_LABELS[t]).join(", ")}`);
  if (parts.length === 0) return "I didn't take anything specific from this";
  return parts.join("; ");
}

/**
 * "What I understood": the running summary. Facts the user said are kept apart from what the
 * engine inferred from them, and every item can be corrected or removed.
 */
export function FactsPanel({ facts, recommendations, editable, busy, onUpdate, onRemove }: Props) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const editButtons = useRef(new Map<string, HTMLButtonElement>());

  const suggested = (recommendations ?? []).filter((r) => r.status === "recommended" || r.status === "consider");

  async function save(fact: ProfileFact) {
    if (!draft.trim()) return;
    if (await onUpdate(fact.id, draft.trim())) {
      setEditing(null);
      requestAnimationFrame(() => editButtons.current.get(fact.id)?.focus());
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <h2 id={headingId} ref={headingRef} tabIndex={-1} className={styles.heading}>
        What I understood
      </h2>
      {facts.length === 0 ? (
        <p className={styles.empty}>Nothing yet. Your answers will appear here, and you can change any of them.</p>
      ) : (
        <ul className={styles.list}>
          {facts.map((fact) => {
            const note = inference(fact);
            return (
              <li key={fact.id} className={styles.fact}>
                {editing === fact.id ? (
                  <div className={styles.editor}>
                    <label className="field-label" htmlFor={`${fact.id}-edit`}>
                      Change this item
                    </label>
                    <textarea
                      id={`${fact.id}-edit`}
                      className="textarea"
                      value={draft}
                      maxLength={600}
                      rows={3}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          setEditing(null);
                          requestAnimationFrame(() => editButtons.current.get(fact.id)?.focus());
                        }
                      }}
                    />
                    <div className={styles.row}>
                      <button type="button" className="button button-primary" onClick={() => save(fact)} disabled={busy || !draft.trim()}>
                        Save
                      </button>
                      <button
                        type="button"
                        className="button-text"
                        onClick={() => {
                          setEditing(null);
                          requestAnimationFrame(() => editButtons.current.get(fact.id)?.focus());
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <p className={styles.text}>{fact.source === "chosen" ? fact.text : `“${fact.text}”`}</p>
                    {fact.source !== "chosen" ? (
                      <p className={styles.meta}>
                        {SOURCE[fact.source]}
                        {note ? ` · ${note}` : ""}
                      </p>
                    ) : null}
                    {editable ? (
                      <div className={styles.row}>
                        <button
                          type="button"
                          className="button-text"
                          ref={(el) => {
                            if (el) editButtons.current.set(fact.id, el);
                            else editButtons.current.delete(fact.id);
                          }}
                          onClick={() => {
                            setEditing(fact.id);
                            setDraft(fact.text);
                          }}
                          disabled={busy}
                        >
                          Edit<span className="visually-hidden">: {fact.text}</span>
                        </button>
                        <button
                          type="button"
                          className="button-text"
                          onClick={async () => {
                            await onRemove(fact.id, fact.text);
                            headingRef.current?.focus();
                          }}
                          disabled={busy}
                        >
                          Remove<span className="visually-hidden">: {fact.text}</span>
                        </button>
                      </div>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {recommendations ? (
        <div className={styles.suggested}>
          <h3 className={styles.subheading}>Suggested so far</h3>
          <p className={styles.suggestedList}>
            {suggested.length > 0
              ? suggested.map((r) => getCatalogEntry(MODULE_CATALOG, r.module_id).name).join(", ")
              : "Just the walker, for now."}
          </p>
        </div>
      ) : null}
    </section>
  );
}
