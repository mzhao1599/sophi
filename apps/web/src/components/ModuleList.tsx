"use client";

import { MODULE_CATALOG, type ModuleId, type SelectionProblem } from "@walker/contracts";
import { lockReason, stateLabel, type PartState } from "@/lib/walker";
import { ModuleSwitch } from "./ModuleSwitch";
import styles from "./WalkerDiagram.module.css";

/**
 * Every module as a plain list with the same switches as the drawing's panels, so the drawing is never
 * the only way to choose. Hovering or focusing a row highlights its part on the drawing.
 */
export function ModuleList({
  states,
  problems,
  frozen,
  onToggle,
  onHighlight,
}: {
  states: Record<ModuleId, PartState>;
  problems: readonly SelectionProblem[];
  frozen: string | null;
  onToggle(id: ModuleId, on: boolean): void;
  onHighlight(id: ModuleId | null): void;
}) {
  return (
    <section className={styles.listSection} aria-labelledby="modules-heading">
      <h2 id="modules-heading" className={styles.listHeading}>
        All modules
      </h2>
      {/* Said once for the whole list (saving, or saved), rather than on every row. */}
      {frozen ? (
        <p id="modules-frozen" className={styles.lockNote}>
          {frozen}
        </p>
      ) : null}
      <ul className={styles.list}>
        {MODULE_CATALOG.modules.map((m) => {
          const rowId = `row-${m.id.replace(".", "-")}`;
          const own = lockReason(m);
          const problem = problems.find((p) => p.module_id === m.id);
          return (
            <li
              key={m.id}
              className={styles.row}
              data-state={states[m.id]}
              onPointerEnter={() => onHighlight(m.id)}
              onPointerLeave={() => onHighlight(null)}
              onFocus={() => onHighlight(m.id)}
              onBlur={() => onHighlight(null)}
            >
              <span className={styles.rowText}>
                <span className={styles.rowName}>{m.name}</span>
                <span id={`${rowId}-state`} className={styles.rowState}>
                  {stateLabel(m.id, states[m.id], true)}
                </span>
                {problem ? (
                  <span id={`${rowId}-problem`} className={styles.problem}>
                    {problem.message}
                  </span>
                ) : null}
              </span>
              <ModuleSwitch
                id={m.id}
                on={states[m.id] === "on"}
                locked={Boolean(own ?? frozen)}
                describedBy={[own ? `${rowId}-state` : frozen ? "modules-frozen" : "", problem ? `${rowId}-problem` : ""].filter(Boolean).join(" ")}
                onToggle={onToggle}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
