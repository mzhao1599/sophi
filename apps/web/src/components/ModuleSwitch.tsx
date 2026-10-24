"use client";

import type { ModuleId } from "@walker/contracts";
import { nameOf } from "@/lib/walker";
import styles from "./WalkerDiagram.module.css";

/**
 * One module's on/off switch, used in the hotspot panel and in the module list so both paths behave
 * the same. A native button with role="switch": its name is the module, aria-checked is the state, and
 * the visible "On"/"Off" means state never rests on colour. Locked switches stay focusable
 * (aria-disabled) and say why through `describedBy`; a press then only announces the reason.
 */
export function ModuleSwitch({
  id,
  on,
  locked,
  describedBy,
  onToggle,
}: {
  id: ModuleId;
  on: boolean;
  locked: boolean;
  describedBy?: string;
  onToggle(id: ModuleId, on: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className={styles.switch}
      aria-checked={on}
      aria-label={nameOf(id)}
      aria-disabled={locked || undefined}
      aria-describedby={describedBy || undefined}
      onClick={() => onToggle(id, !on)}
    >
      <span className={styles.track} aria-hidden="true">
        <span className={styles.thumb} />
      </span>
      <span className={styles.switchText} aria-hidden="true">
        {on ? "On" : "Off"}
      </span>
    </button>
  );
}
