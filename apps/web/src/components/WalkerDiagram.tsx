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
 * The walker seen from the front, drawn as flat pieces, with each module where it mounts. A
 * schematic, not to scale: it shows what is on the walker, not what any part has been measured to
 * do. Parts on the walker are solid; parts left off are dashed outlines, so the difference never
 * rests on colour alone. The caption carries the same information as text, so the drawing itself
 * is hidden from screen readers. Colours come from --d-* custom properties set by the screen.
 */
export function WalkerDiagram({ states, highlight, caption, legend = true }: Props) {
  const part = (id: ModuleId) => ({
    "data-state": states[id],
    "data-highlight": highlight === id ? "true" : undefined,
    className: styles.part,
  });

  return (
    <figure className={styles.figure}>
      <svg viewBox="0 0 320 380" className={styles.svg} aria-hidden="true" focusable="false">
        {/* Frame and coordinator: always present */}
        <g {...part("base.walker")}>
          <rect className={styles.frame} x="60" y="58" width="16" height="270" rx="8" />
          <rect className={styles.frame} x="244" y="58" width="16" height="270" rx="8" />
          <rect className={styles.frame} x="60" y="132" width="200" height="12" rx="6" />
          <rect className={styles.frame} x="60" y="230" width="200" height="18" rx="9" />
          <circle className={styles.frame} cx="68" cy="336" r="24" />
          <circle className={styles.frame} cx="252" cy="336" r="24" />
          <circle className={styles.hub} cx="68" cy="336" r="8" />
          <circle className={styles.hub} cx="252" cy="336" r="8" />
          <rect className={styles.box} x="186" y="262" width="52" height="30" rx="6" />
        </g>

        {/* Lift: an upright column at the front, carrying the arms */}
        <g {...part("manipulation.lift")}>
          <rect className={styles.box} x="151" y="150" width="18" height="150" rx="4" />
        </g>
        <g {...part("manipulation.arm")}>
          <path className={styles.arm} d="M151 198 L114 178 L98 208" />
          <path className={styles.arm} d="M169 198 L206 178 L222 208" />
          <circle className={styles.box} cx="98" cy="214" r="7" />
          <circle className={styles.box} cx="222" cy="214" r="7" />
        </g>

        {/* Obstacle sensors along the front of the seat bar, either side of the lift */}
        <g {...part("perception.tof")}>
          <rect className={styles.box} x="84" y="232" width="22" height="14" rx="3" />
          <rect className={styles.box} x="116" y="232" width="22" height="14" rx="3" />
          <rect className={styles.box} x="182" y="232" width="22" height="14" rx="3" />
          <rect className={styles.box} x="214" y="232" width="22" height="14" rx="3" />
        </g>

        {/* Voice: microphone and speaker on the upper bar, between the handles */}
        <g {...part("voice")}>
          <rect className={styles.box} x="136" y="114" width="48" height="44" rx="10" />
        </g>

        {/* Hand controls on both grips; the round mark is the button you press to start */}
        <g {...part("controls.hand")}>
          <rect className={styles.box} x="34" y="38" width="68" height="30" rx="15" />
          <rect className={styles.box} x="218" y="38" width="68" height="30" rx="15" />
          <circle className={styles.button} cx="54" cy="53" r="6" />
          <circle className={styles.button} cx="266" cy="53" r="6" />
        </g>

        {/* Location receiver inside the left upright */}
        <g {...part("location.gps")}>
          <rect className={styles.box} x="62" y="84" width="12" height="26" rx="3" />
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
