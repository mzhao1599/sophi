"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  MODULE_CATALOG,
  checkSelection,
  type ModuleCatalogEntry,
  type ModuleId,
  type ProfileFact,
  type Recommendation,
  type SessionView,
} from "@walker/contracts";
import { useOnboarding, type Onboarding } from "@/lib/useOnboarding";
import { FactsPanel } from "./FactsPanel";
import { SavedConfiguration } from "./SavedConfiguration";
import { TopBar } from "./TopBar";
import { WalkerDiagram, type PartState } from "./WalkerDiagram";
import screen from "./Screen.module.css";
import styles from "./ReviewScreen.module.css";

const STATUS_LABEL: Record<Recommendation["status"], string | null> = {
  required: "Part of every setup",
  recommended: "Suggested for you",
  consider: "Worth considering",
  not_suggested: null,
  unavailable: "Not available yet",
};

const STATUS_PILL: Record<Recommendation["status"], string> = {
  required: "pill pill-neutral",
  recommended: "pill pill-recommended",
  consider: "pill pill-consider",
  not_suggested: "pill pill-neutral",
  unavailable: "pill pill-neutral",
};

function estimateLine(entry: ModuleCatalogEntry): string {
  const parts = (["cost", "weight", "power"] as const).map((k) => {
    const e = entry.estimates[k];
    return e.status === "measured" ? `${k} ${e.value} ${e.unit}` : null;
  });
  if (parts.every((p) => p === null)) return "Cost, weight and power use: not measured yet.";
  return parts.map((p, i) => p ?? `${["cost", "weight", "power"][i]} not measured yet`).join(" · ");
}

const isDefault = (r: Recommendation) => r.status === "required" || r.status === "recommended";

/**
 * Review: "Which modules will my walker have?" The module list answers it with reasons quoted from
 * the user's own answers; the walker drawing beside it shows the answer as a picture.
 */
export function ReviewScreen() {
  return <ReviewView o={useOnboarding()} />;
}

export function ReviewView({ o }: { o: Onboarding }) {
  const s = o.session;

  return (
    <>
      <TopBar session={s} onReset={s ? o.reset : undefined} busy={o.busy} />
      <main id="main" className={screen.main}>
        <p className="visually-hidden" role="status" aria-live="polite">
          {o.status}
        </p>
        {o.phase === "loading" ? <p className={screen.loading}>Loading your setup…</p> : null}
        {o.phase === "none" ? <NoSession /> : null}
        {s && s.state === "collecting" ? <StillCollecting session={s} onSkipRest={o.skipRest} busy={o.busy} /> : null}
        {s && s.state === "review" ? <Review key={s.session_id} session={s} o={o} /> : null}
        {s && s.state === "confirmed" && s.configuration ? (
          <SavedConfiguration session={s} configuration={s.configuration} busy={o.busy} onStartOver={o.reset} />
        ) : null}
      </main>
    </>
  );
}

function NoSession() {
  return (
    <section aria-labelledby="none-heading">
      <h1 id="none-heading" className={screen.doneTitle}>
        No setup in progress
      </h1>
      <p className={screen.lead}>Your demo answers were deleted, or this tab hasn&apos;t started a setup yet.</p>
      <div className={screen.actions}>
        <Link href="/onboarding" className="button button-primary">
          Start a setup
        </Link>
      </div>
    </section>
  );
}

function StillCollecting({ session, onSkipRest, busy }: { session: SessionView; onSkipRest(): void; busy: boolean }) {
  const left = session.progress.total - session.progress.answered;
  return (
    <section aria-labelledby="collecting-heading">
      <h1 id="collecting-heading" className={screen.doneTitle}>
        A few questions left
      </h1>
      <p className={screen.lead}>
        {left === 1 ? "There's 1 question" : `There are ${left} questions`} left. You can answer them, or skip them and review
        what you have.
      </p>
      <div className={screen.actions}>
        <Link href="/onboarding" className="button button-primary">
          Back to the questions
        </Link>
        <button type="button" className="button-text" onClick={onSkipRest} disabled={busy}>
          Skip them and review
        </button>
      </div>
    </section>
  );
}

function Review({ session, o }: { session: SessionView; o: Onboarding }) {
  const [choices, setChoices] = useState<Partial<Record<ModuleId, boolean>>>({});
  const [highlight, setHighlight] = useState<ModuleId | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const recs = useMemo(() => new Map(session.recommendations.map((r) => [r.module_id, r])), [session.recommendations]);
  const factById = useMemo(() => new Map(session.facts.map((f) => [f.id, f])), [session.facts]);

  // A module the user hasn't touched follows the current suggestions, so editing an answer updates it.
  const selected = MODULE_CATALOG.modules
    .map((m) => m.id)
    .filter((id) => choices[id] ?? (recs.get(id) ? isDefault(recs.get(id)!) : false));
  const problems = checkSelection(MODULE_CATALOG, selected);
  const problemFor = (id: ModuleId) => problems.find((p) => p.module_id === id);

  const states = Object.fromEntries(
    MODULE_CATALOG.modules.map((m) => {
      const r = recs.get(m.id);
      const state: PartState = selected.includes(m.id)
        ? "selected"
        : r?.status === "unavailable"
          ? "unavailable"
          : r?.status === "recommended" || r?.status === "consider"
            ? "suggested"
            : "off";
      return [m.id, state];
    }),
  ) as Record<ModuleId, PartState>;

  const names = selected.map((id) => MODULE_CATALOG.modules.find((m) => m.id === id)!.name);
  const caption = `On your walker: ${names.join(", ")}.`;

  const suggestedGroup = MODULE_CATALOG.modules.filter((m) => {
    const st = recs.get(m.id)?.status;
    return st === "required" || st === "recommended" || st === "consider";
  });
  const otherGroup = MODULE_CATALOG.modules.filter((m) => !suggestedGroup.includes(m));

  async function save() {
    setSubmitted(true);
    if (problems.length > 0) return;
    await o.confirm(selected);
  }

  const row = (m: ModuleCatalogEntry) => (
    <ModuleRow
      key={m.id}
      entry={m}
      rec={recs.get(m.id)!}
      facts={factById}
      checked={selected.includes(m.id)}
      problem={submitted || choices[m.id] !== undefined ? problemFor(m.id)?.message : undefined}
      onChange={(checked) => setChoices((c) => ({ ...c, [m.id]: checked }))}
      onFocusRow={setHighlight}
      busy={o.busy}
    />
  );

  return (
    <div className={screen.grid}>
      <header className={`${screen.span12} ${styles.header}`}>
        <h1 className={screen.doneTitle}>Choose your modules</h1>
        <p className={screen.lead}>
          Each suggestion comes from your answers and says why. Choosing a module records what you want; nothing is
          installed yet.
        </p>
      </header>

      <div className={`${screen.span8} ${styles.listColumn}`}>
        <section aria-labelledby="suggested-heading">
          <h2 id="suggested-heading" className={styles.groupHeading}>
            Suggested for you
          </h2>
          <ul className={styles.modules}>{suggestedGroup.map(row)}</ul>
        </section>
        <section aria-labelledby="other-heading">
          <h2 id="other-heading" className={styles.groupHeading}>
            Other modules
          </h2>
          <p className={styles.groupNote}>Nothing you said points to these, but you can add any that are available.</p>
          <ul className={styles.modules}>{otherGroup.map(row)}</ul>
        </section>
        <FactsPanel facts={session.facts} editable busy={o.busy} onUpdate={o.updateFact} onRemove={o.removeFact} />
        <div className={styles.bottomSave}>
          <button type="button" className="button button-primary" onClick={save} disabled={o.busy}>
            {o.busy ? "Saving…" : `Save this setup (${selected.length} modules)`}
          </button>
        </div>
      </div>

      <aside className={`${screen.span4} ${styles.aside}`} aria-labelledby="summary-heading">
        <div className={styles.summaryCard}>
          <h2 id="summary-heading" className={styles.summaryHeading}>
            Your walker
          </h2>
          <WalkerDiagram states={states} highlight={highlight} caption={caption} />
          <p className={styles.count}>
            {selected.length} of {MODULE_CATALOG.modules.length} modules
          </p>
          {submitted && problems.length > 0 ? (
            <div role="alert" className={styles.problems}>
              <p>Before saving:</p>
              <ul>
                {problems.map((p) => (
                  <li key={`${p.module_id}-${p.code}`}>{p.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {o.error ? (
            <p role="alert" className={styles.problems}>
              {o.error}
            </p>
          ) : null}
          <div className={styles.saveRow}>
            <button type="button" className="button button-primary" onClick={save} disabled={o.busy}>
              {o.busy ? "Saving…" : "Save this setup"}
            </button>
            <Link href="/onboarding" className="button-text">
              Change your answers
            </Link>
          </div>
        </div>
      </aside>
    </div>
  );
}

function ModuleRow({
  entry,
  rec,
  facts,
  checked,
  problem,
  onChange,
  onFocusRow,
  busy,
}: {
  entry: ModuleCatalogEntry;
  rec: Recommendation;
  facts: Map<string, ProfileFact>;
  checked: boolean;
  problem: string | undefined;
  onChange(checked: boolean): void;
  onFocusRow(id: ModuleId | null): void;
  busy: boolean;
}) {
  const id = `module-${entry.id.replace(".", "-")}`;
  const locked = rec.status === "required" || rec.status === "unavailable";
  const label = STATUS_LABEL[rec.status];
  const quoted = rec.reasons.filter((r) => r.fact_id);

  return (
    <li
      className={styles.module}
      data-checked={checked}
      onMouseEnter={() => onFocusRow(entry.id)}
      onMouseLeave={() => onFocusRow(null)}
      onFocus={() => onFocusRow(entry.id)}
      onBlur={() => onFocusRow(null)}
    >
      <div className={styles.check}>
        {/* Locked rows use aria-disabled rather than disabled, so the state stays legible and focusable. */}
        <input
          type="checkbox"
          id={id}
          checked={checked}
          aria-disabled={locked || undefined}
          disabled={busy}
          onChange={(e) => {
            if (!locked) onChange(e.target.checked);
          }}
          aria-describedby={`${id}-summary${problem ? ` ${id}-problem` : ""}${locked ? ` ${id}-locked` : ""}`}
        />
      </div>
      <div className={styles.body}>
        <div className={styles.titleRow}>
          <label htmlFor={id} className={styles.name}>
            {entry.name}
          </label>
          {label ? <span className={STATUS_PILL[rec.status]}>{label}</span> : null}
        </div>
        <p id={`${id}-summary`} className={styles.summary}>
          {entry.summary}
        </p>
        {locked ? (
          <p id={`${id}-locked`} className={styles.why}>
            {rec.status === "required" ? "Included in every setup, so it can't be removed." : "It can't be chosen until it's built."}
          </p>
        ) : null}

        {quoted.length > 0 ? (
          <ul className={styles.reasons}>
            {quoted.map((r) => {
              const fact = r.fact_id ? facts.get(r.fact_id) : undefined;
              return (
                <li key={`${r.fact_id}-${r.text}`}>
                  <p>{r.text}</p>
                  {fact ? (
                    <p className={styles.from}>
                      Because: {fact.source === "chosen" ? fact.text : `“${fact.text}”`}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {rec.notes.length > 0 ? (
          <ul className={styles.notes}>
            {rec.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}

        {problem ? (
          <p id={`${id}-problem`} className={styles.problem}>
            {problem}
          </p>
        ) : null}

        <details className={styles.details}>
          <summary>Limits and requirements</summary>
          <div className={styles.detailBody}>
            <h3>What it doesn&apos;t do</h3>
            <ul>
              {entry.limitations.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <h3>What it needs</h3>
            <ul>
              {entry.prerequisites.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {entry.lighter_alternative ? (
              <>
                <h3>A lighter option</h3>
                <p>{entry.lighter_alternative}</p>
              </>
            ) : null}
            <p className={styles.estimates}>{estimateLine(entry)}</p>
          </div>
        </details>
      </div>
    </li>
  );
}
