"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { MODULE_CATALOG, checkSelection, type ModuleId } from "@walker/contracts";
import { WalkerDiagram, type PartState } from "../WalkerDiagram";
import styles from "./Landing.module.css";

const CHOOSABLE = MODULE_CATALOG.modules.filter((m) => m.default !== "required");

/**
 * The hero card and its tear-off stub: the walker's build sheet. Ticking a module on the stub draws it
 * on the walker in the card. It uses the real catalog and the same dependency rules as the review
 * screen; nothing here is saved or sent anywhere.
 */
export function BuildSheet({ children }: { children: ReactNode }) {
  const [chosen, setChosen] = useState<ModuleId[]>([]);
  const selected: ModuleId[] = ["base.walker", ...chosen];
  const problems = checkSelection(MODULE_CATALOG, selected);

  const states = Object.fromEntries(
    MODULE_CATALOG.modules.map((m) => {
      const state: PartState = selected.includes(m.id) ? "selected" : m.availability === "deferred" ? "unavailable" : "suggested";
      return [m.id, state];
    }),
  ) as Record<ModuleId, PartState>;

  const names = selected.map((id) => MODULE_CATALOG.modules.find((m) => m.id === id)!.name);

  return (
    <div className={styles.sheetStack}>
      <div className={styles.card}>
        <span className={styles.scallop} data-corner="tl" aria-hidden="true" />
        <span className={styles.scallop} data-corner="tr" aria-hidden="true" />
        <span className={styles.scallop} data-corner="bl" aria-hidden="true" />
        <span className={styles.scallop} data-corner="br" aria-hidden="true" />
        {children}
        <div className={styles.cardDrawing}>
          <WalkerDiagram
            states={states}
            highlight={null}
            legend={false}
            caption={`Solid parts are on this walker: ${names.join(", ")}. Dashed parts are left off.`}
          />
        </div>
      </div>

      <section className={styles.stub} aria-labelledby="build-heading">
        <h2 id="build-heading" className={styles.stubHeading}>
          Build one here
        </h2>
        <p className={styles.stubNote}>Tick a part to see where it goes. Nothing is saved.</p>
        <ul className={styles.stubList}>
          {CHOOSABLE.map((m) => {
            const deferred = m.availability === "deferred";
            return (
              <li key={m.id}>
                <label className={styles.stubOption} data-deferred={deferred || undefined}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(m.id)}
                    aria-disabled={deferred || undefined}
                    onChange={(e) => {
                      if (deferred) return;
                      setChosen((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)));
                    }}
                  />
                  <span>
                    <span className={styles.stubName}>{m.name}</span>
                    <span className={styles.stubPlace}>{deferred ? "Not built yet" : m.placement}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className={styles.stubProblem} aria-live="polite">
          {problems.map((p) => p.message).join(" ")}
        </p>
        <Link href="/onboarding" className="button button-primary">
          Set up yours properly
        </Link>
      </section>
    </div>
  );
}
