import type { ModuleId } from "@walker/contracts";
import styles from "./WalkerDiagram.module.css";

export type PartState = "selected" | "suggested" | "off" | "unavailable";

interface Props {
  states: Record<ModuleId, PartState>;
  highlight: ModuleId | null;
  caption: string;
  /** The key to the marks. Off when the caption already explains them. */
  legend?: boolean;
}

/**
 * The walker seen from the front, with each module drawn where it mounts. A schematic, not to scale:
 * it shows what is on the walker, not what any part has been measured to do. The caption carries the
 * same information as text, so the drawing itself is hidden from screen readers.
 */
export function WalkerDiagram({ states, highlight, caption, legend = true }: Props) {
  const part = (id: ModuleId) => ({
    "data-state": states[id],
    "data-highlight": highlight === id ? "true" : undefined,
    className: styles.part,
  });

  return (
    <figure className={styles.figure}>
      <svg viewBox="0 0 320 360" className={styles.svg} aria-hidden="true" focusable="false">
        {/* Frame and coordinator: always present */}
        <g {...part("base.walker")}>
          <path className={styles.frame} d="M70 66 V316 M250 66 V316 M70 140 H250 M70 236 H250" />
          <circle className={styles.wheel} cx="70" cy="326" r="12" />
          <circle className={styles.wheel} cx="250" cy="326" r="12" />
          <rect className={styles.box} x="192" y="258" width="44" height="26" rx="6" />
        </g>

        {/* Lift: an upright column at the front, with the arms on its carriage */}
        <g {...part("manipulation.lift")}>
          <rect className={styles.box} x="152" y="196" width="16" height="104" rx="4" />
        </g>
        <g {...part("manipulation.arm")}>
          <path className={styles.arm} d="M152 214 L116 196 L100 222" />
          <path className={styles.arm} d="M168 214 L204 196 L220 222" />
          <circle className={styles.joint} cx="100" cy="226" r="5" />
          <circle className={styles.joint} cx="220" cy="226" r="5" />
        </g>

        {/* Obstacle sensors along the lower crossbar, either side of the lift */}
        <g {...part("perception.tof")}>
          <rect className={styles.box} x="86" y="230" width="18" height="12" rx="3" />
          <rect className={styles.box} x="118" y="230" width="18" height="12" rx="3" />
          <rect className={styles.box} x="184" y="230" width="18" height="12" rx="3" />
          <rect className={styles.box} x="216" y="230" width="18" height="12" rx="3" />
        </g>

        {/* Voice: microphone and speaker on the upper crossbar */}
        <g {...part("voice")}>
          <rect className={styles.box} x="140" y="124" width="40" height="32" rx="8" />
        </g>

        {/* Hand controls on both grips */}
        <g {...part("controls.hand")}>
          <rect className={styles.box} x="44" y="40" width="52" height="24" rx="12" />
          <rect className={styles.box} x="224" y="40" width="52" height="24" rx="12" />
        </g>

        {/* Location receiver inside the left upright */}
        <g {...part("location.gps")}>
          <rect className={styles.box} x="78" y="84" width="20" height="20" rx="4" />
        </g>
      </svg>
      <figcaption className={styles.caption}>{caption}</figcaption>
      {legend ? (
      <ul className={styles.legend} aria-hidden="true">
        <li>
          <span className={styles.swatch} data-state="selected" /> On your walker
        </li>
        <li>
          <span className={styles.swatch} data-state="suggested" /> Suggested, not chosen
        </li>
        <li>
          <span className={styles.swatch} data-state="off" /> Not included
        </li>
      </ul>
      ) : null}
    </figure>
  );
}
