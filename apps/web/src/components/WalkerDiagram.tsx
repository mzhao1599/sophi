"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  MODULE_CATALOG,
  getCatalogEntry,
  type ModuleId,
  type ProfileFact,
  type Recommendation,
  type SelectionProblem,
} from "@walker/contracts";
import { lockReason, nameOf, stateLabel, whySuggested, type PartState } from "@/lib/walker";
import { ModuleSwitch } from "./ModuleSwitch";
import styles from "./WalkerDiagram.module.css";

/*
 * Coordinates. The walker is drawn in a 320 x 380 box. On a wide stage, a label column of 150 units
 * sits on each side (the leader-line layer's box is 620 x 380, starting at x = -150), and each module's
 * hotspot is its label there. On a narrow stage, the labels don't fit, so each hotspot is a 44px
 * round marker on the part itself. Both positions come from this one table, as percentages, so the
 * HTML buttons line up with the SVG at any size.
 */
const DRAW_W = 320;
const H = 380;
const SIDE = 150;
const WIDE_W = DRAW_W + 2 * SIDE;
const LABEL_GAP = 10;

interface Spot {
  id: ModuleId;
  /** Where on the drawing the leader line ends, and where the narrow marker sits. */
  anchor: [number, number];
  side: "left" | "right";
  /** The label's vertical centre in the wide layout. */
  labelY: number;
}

// Spaced so that, at the smallest size the stage draws them, no two 44px targets overlap.
const SPOTS: Spot[] = [
  { id: "controls.hand", anchor: [30, 53], side: "left", labelY: 53 },
  { id: "location.gps", anchor: [68, 97], side: "left", labelY: 146 },
  { id: "perception.tof", anchor: [95, 239], side: "left", labelY: 240 },
  { id: "base.walker", anchor: [44, 336], side: "left", labelY: 336 },
  { id: "voice", anchor: [184, 128], side: "right", labelY: 92 },
  { id: "manipulation.arm", anchor: [229, 210], side: "right", labelY: 194 },
  { id: "manipulation.lift", anchor: [169, 284], side: "right", labelY: 296 },
];

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
const labelEdge = (side: Spot["side"]) => (side === "left" ? -LABEL_GAP : DRAW_W + LABEL_GAP);

function spotStyle(s: Spot): React.CSSProperties {
  return {
    "--wx": pct((labelEdge(s.side) + SIDE) / WIDE_W),
    "--wy": pct(s.labelY / H),
    "--nx": pct(s.anchor[0] / DRAW_W),
    "--ny": pct(s.anchor[1] / H),
  } as React.CSSProperties;
}

/** The leader from the label's edge: level for a short way, then straight to the part. */
function leader(s: Spot): string {
  const x0 = labelEdge(s.side);
  const elbow = s.side === "left" ? Math.min(s.anchor[0] - 14, x0 + 26) : Math.max(s.anchor[0] + 14, x0 - 26);
  return `M${x0} ${s.labelY} H${elbow} L${s.anchor[0]} ${s.anchor[1]}`;
}

function StateIcon({ state }: { state: PartState }) {
  return (
    <svg className={styles.icon} viewBox="0 0 20 20" aria-hidden="true" focusable="false" data-state={state}>
      <circle cx="10" cy="10" r="8.5" />
      {state === "on" ? <path d="M6 10.4l2.6 2.6L14 7.6" /> : state === "unavailable" ? <path d="M6.5 10h7" /> : <path d="M10 6.5v7M6.5 10h7" />}
    </svg>
  );
}

export interface WalkerDiagramProps {
  recs: readonly Recommendation[];
  facts: readonly ProfileFact[];
  states: Record<ModuleId, PartState>;
  /** The person is choosing: hotspots are buttons with panels. Otherwise the drawing is a live picture. */
  review: boolean;
  problems: readonly SelectionProblem[];
  /** Why every switch is locked right now (saving, or saved), or null. */
  frozen: string | null;
  onToggle(id: ModuleId, on: boolean): void;
  highlight: ModuleId | null;
  onHighlight(id: ModuleId | null): void;
  caption: string;
}

/**
 * The walker seen from the front, drawn as flat pieces with each module where it mounts. A schematic,
 * not to scale. Parts on the walker are solid; parts left off are dashed, so state never rests on colour
 * alone. The drawing itself is hidden from screen readers: the caption says the same in words, and in
 * review each module is a real button that opens a panel with its switch. The module list beside the
 * drawing is an equal path for the same choices.
 */
export function WalkerDiagram({ recs, facts, states, review, problems, frozen, onToggle, highlight, onHighlight, caption }: WalkerDiagramProps) {
  const [open, setOpen] = useState<ModuleId | null>(null);
  const spotRefs = useRef(new Map<ModuleId, HTMLDivElement>());
  const buttonRefs = useRef(new Map<ModuleId, HTMLButtonElement>());
  const recById = new Map(recs.map((r) => [r.module_id, r]));
  const shown = review ? open : null;

  // A press anywhere outside the open panel and its hotspot closes it, without moving focus.
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: PointerEvent) => {
      const spot = spotRefs.current.get(shown);
      if (spot && !spot.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [shown]);

  function onKeyDown(e: KeyboardEvent, id: ModuleId) {
    if (e.key === "Escape" && shown === id) {
      e.stopPropagation();
      setOpen(null);
      buttonRefs.current.get(id)?.focus();
    }
  }

  const part = (id: ModuleId) => ({
    "data-state": states[id],
    "data-highlight": highlight === id || shown === id ? "true" : undefined,
    className: styles.part,
    // A bonus for pointer users: the drawn part opens the same panel as its hotspot button.
    ...(review
      ? {
          onClick: () => setOpen((o) => (o === id ? null : id)),
          onPointerEnter: () => onHighlight(id),
          onPointerLeave: () => onHighlight(null),
          "data-clickable": "true",
        }
      : {}),
  });

  return (
    <figure className={styles.figure} data-review={review || undefined}>
      <div className={styles.canvas}>
        <svg className={styles.leaders} viewBox={`${-SIDE} 0 ${WIDE_W} ${H}`} aria-hidden="true" focusable="false">
          {SPOTS.map((s) => (
            <g key={s.id} className={styles.leader} data-state={states[s.id]} data-highlight={highlight === s.id || shown === s.id || undefined}>
              <path d={leader(s)} />
              <circle cx={s.anchor[0]} cy={s.anchor[1]} r="3.5" />
            </g>
          ))}
        </svg>

        <svg className={styles.drawing} viewBox={`0 0 ${DRAW_W} ${H}`} aria-hidden="true" focusable="false">
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

        {SPOTS.map((s) => {
          const entry = getCatalogEntry(MODULE_CATALOG, s.id);
          const rec = recById.get(s.id);
          const label = stateLabel(s.id, states[s.id], review);
          const panelId = `panel-${s.id.replace(".", "-")}`;
          const isOpen = shown === s.id;
          return (
            <div
              key={s.id}
              ref={(el) => {
                if (el) spotRefs.current.set(s.id, el);
                else spotRefs.current.delete(s.id);
              }}
              className={styles.spot}
              data-side={s.side}
              data-low={s.labelY > H / 2 || undefined}
              data-open={isOpen || undefined}
              style={spotStyle(s)}
              onKeyDown={(e) => onKeyDown(e, s.id)}
            >
              {review ? (
                <button
                  ref={(el) => {
                    if (el) buttonRefs.current.set(s.id, el);
                    else buttonRefs.current.delete(s.id);
                  }}
                  type="button"
                  className={styles.hotspot}
                  data-state={states[s.id]}
                  // Said in full here rather than left to the nested text, which is hidden on narrow screens.
                  aria-label={`${entry.name}, ${label}`}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? panelId : undefined}
                  onClick={() => setOpen(isOpen ? null : s.id)}
                  onPointerEnter={() => onHighlight(s.id)}
                  onPointerLeave={() => onHighlight(null)}
                  onFocus={() => onHighlight(s.id)}
                  onBlur={() => onHighlight(null)}
                >
                  <StateIcon state={states[s.id]} />
                  <span className={styles.spotText}>
                    <span className={styles.spotName}>{entry.name}</span>
                    <span className={styles.spotState}>{label}</span>
                  </span>
                </button>
              ) : (
                <span className={styles.hotspot} data-state={states[s.id]} aria-hidden="true">
                  <StateIcon state={states[s.id]} />
                  <span className={styles.spotText}>
                    <span className={styles.spotName}>{entry.name}</span>
                    <span className={styles.spotState}>{label}</span>
                  </span>
                </span>
              )}
              {isOpen ? (
                <ModulePanel
                  id={s.id}
                  panelId={panelId}
                  rec={rec}
                  facts={facts}
                  on={states[s.id] === "on"}
                  problem={problems.find((p) => p.module_id === s.id) ?? null}
                  frozen={frozen}
                  onToggle={onToggle}
                  onClose={() => {
                    setOpen(null);
                    buttonRefs.current.get(s.id)?.focus();
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <figcaption className={styles.caption}>{caption}</figcaption>
    </figure>
  );
}

/** The small panel next to a hotspot: what the module does, why it was suggested, and its switch. */
function ModulePanel({
  id,
  panelId,
  rec,
  facts,
  on,
  problem,
  frozen,
  onToggle,
  onClose,
}: {
  id: ModuleId;
  panelId: string;
  rec: Recommendation | undefined;
  facts: readonly ProfileFact[];
  on: boolean;
  problem: SelectionProblem | null;
  frozen: string | null;
  onToggle(id: ModuleId, on: boolean): void;
  onClose(): void;
}) {
  const entry = getCatalogEntry(MODULE_CATALOG, id);
  const why = whySuggested(rec, facts);
  const locked = lockReason(entry) ?? frozen;
  const suggested = rec?.status === "recommended" || rec?.status === "consider";
  return (
    <div id={panelId} className={styles.panel} role="group" aria-labelledby={`${panelId}-title`}>
      <div className={styles.panelHead}>
        <h3 id={`${panelId}-title`} className={styles.panelTitle}>
          {entry.name}
        </h3>
        <button type="button" className={styles.close} onClick={onClose} aria-label={`Close ${nameOf(id)}`}>
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
          </svg>
        </button>
      </div>
      <p className={styles.panelText}>{entry.summary}</p>
      {why && (suggested || rec?.status === "required") ? (
        <p className={styles.panelWhy}>
          <span className={styles.whyLabel}>{rec?.status === "required" ? "Why it's there" : "Why it was suggested"}</span>
          {why.reason}
          {why.because ? <span className={styles.because}> Based on: {why.because}</span> : null}
        </p>
      ) : rec?.status === "unavailable" ? (
        <p className={styles.panelWhy}>{why?.reason ?? "This isn't built yet."}</p>
      ) : (
        <p className={styles.panelMuted}>Nothing you said points to this, but you can add it.</p>
      )}
      {problem ? (
        <p id={`${panelId}-problem`} className={styles.problem}>
          {problem.message}
        </p>
      ) : null}
      <div className={styles.panelSwitch}>
        <ModuleSwitch
          id={id}
          on={on}
          locked={Boolean(locked)}
          describedBy={[locked ? `${panelId}-locked` : "", problem ? `${panelId}-problem` : ""].filter(Boolean).join(" ")}
          onToggle={onToggle}
        />
        {locked ? (
          <span id={`${panelId}-locked`} className={styles.lockNote}>
            {locked}
          </span>
        ) : (
          <span className={styles.lockNote} aria-hidden="true">
            {on ? "On your walker" : "Not on your walker"}
          </span>
        )}
      </div>
    </div>
  );
}
