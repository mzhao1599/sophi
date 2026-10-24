"use client";

import Link from "next/link";
import { useState } from "react";
import { MODULE_CATALOG, checkSelection, type ModuleId } from "@walker/contracts";
import { WalkerDiagram, type PartState } from "../WalkerDiagram";
import styles from "./Landing.module.css";

/** Where each module goes and what it does, in the landing page's words. Keyed to the real catalog. */
const COPY: Record<ModuleId, { where: string; what: string }> = {
  "base.walker": {
    where: "The frame",
    what: "The frame, battery, stop switch and the Raspberry Pi that runs the rest.",
  },
  "controls.hand": { where: "Both handles", what: "Large buttons and a trigger, with vibration you can feel." },
  "perception.tof": { where: "Front of the frame", what: "A cue when something is close. It doesn't steer or brake." },
  voice: { where: "Between the handles", what: "Press a button and ask out loud. Replies also appear as text." },
  "manipulation.arm": {
    where: "Front, on the lift",
    what: "Two small arms for light objects in a tested area, after you press start.",
  },
  "manipulation.lift": { where: "Front column", what: "Raises the arms toward a shelf, between tested heights." },
  "location.gps": { where: "Not built yet", what: "For someone you choose, once it has its own consent design." },
};

/**
 * The modules, as the walker's parts list. Ticking a module draws it on the walker beside the list,
 * which stays in view while you choose. It uses the real catalog and the review screen's dependency
 * rules; nothing here is saved or sent anywhere.
 */
export function ModuleBuilder() {
  const [chosen, setChosen] = useState<ModuleId[]>([]);
  const [highlight, setHighlight] = useState<ModuleId | null>(null);
  const selected: ModuleId[] = ["base.walker", ...chosen];
  const problems = checkSelection(MODULE_CATALOG, selected);

  const states = Object.fromEntries(
    MODULE_CATALOG.modules.map((m) => {
      const state: PartState = selected.includes(m.id) ? "selected" : m.availability === "deferred" ? "unavailable" : "off";
      return [m.id, state];
    }),
  ) as Record<ModuleId, PartState>;

  const names = selected.map((id) => MODULE_CATALOG.modules.find((m) => m.id === id)!.name);

  return (
    <div className={styles.builder}>
      <div className={styles.builderList}>
        <h2 id="modules-heading" className={styles.giantWord} data-reveal>
          Modules
        </h2>
        <p className={styles.builderNote} data-reveal>
          Every module is optional except the frame. Tick one to see where it goes; nothing is saved.
        </p>
        <ul className={styles.bars} data-reveal>
          {MODULE_CATALOG.modules.map((m) => {
            const required = m.default === "required";
            const deferred = m.availability === "deferred";
            const locked = required || deferred;
            const id = `build-${m.id.replace(".", "-")}`;
            return (
              <li
                key={m.id}
                className={styles.bar}
                data-on={selected.includes(m.id)}
                data-locked={locked || undefined}
                onMouseEnter={() => setHighlight(m.id)}
                onMouseLeave={() => setHighlight(null)}
              >
                {/* The label stretches over the whole bar, so any point of it toggles the box. */}
                <label className={styles.barName} htmlFor={id}>
                  {m.name}
                </label>
                <span className={styles.barWhere} id={`${id}-where`}>
                  {required ? "Always on" : COPY[m.id].where}
                </span>
                <span className={styles.barWhat} id={`${id}-what`}>
                  {COPY[m.id].what}
                </span>
                {/* Locked rows use aria-disabled rather than disabled, so they stay legible and focusable. */}
                <input
                  id={id}
                  type="checkbox"
                  className={styles.barBox}
                  checked={selected.includes(m.id)}
                  aria-disabled={locked || undefined}
                  aria-describedby={`${id}-where ${id}-what`}
                  onFocus={() => setHighlight(m.id)}
                  onBlur={() => setHighlight(null)}
                  onChange={(e) => {
                    if (locked) return;
                    setChosen((c) => (e.target.checked ? [...c, m.id] : c.filter((x) => x !== m.id)));
                  }}
                />
              </li>
            );
          })}
        </ul>
        <p className={styles.builderClose} data-reveal>
          Cost, weight and power use haven&apos;t been measured yet. Nothing is switched on until it passes bench tests.
        </p>
      </div>

      <div className={styles.builderFigure}>
        <div className={styles.builderSticky}>
          <WalkerDiagram
            states={states}
            highlight={highlight}
            legend={false}
            caption={`Solid parts are on this walker: ${names.join(", ")}. Dashed parts are left off.`}
          />
          <p className={styles.builderProblem} aria-live="polite">
            {problems.map((p) => p.message).join(" ")}
          </p>
          <Link href="/onboarding" className={styles.action}>
            Set up yours properly
          </Link>
        </div>
      </div>
    </div>
  );
}
