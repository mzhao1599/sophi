"use client";

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  MODULE_CATALOG,
  getCatalogEntry,
  type ModuleId,
  type ProfileFact,
  type Recommendation,
  type SelectionProblem,
} from "@walker/contracts";
import { useReducedMotion } from "@/lib/motion";
import { lockReason, nameOf, stateLabel, whySuggested, type PartState } from "@/lib/walker";

/** States that put a part on the drawing with its name: on, worth considering, or a "no" the person gave. */
const LIT: readonly PartState[] = ["on", "suggested", "declined"];
const isLit = (state: PartState) => LIT.includes(state);
/** Seconds between parts that arrive together, so each one can be read with its name (Request 3 in docs/demo/script.md). */
export const STAGGER = 0.36;
import { ModuleSwitch } from "./ModuleSwitch";
import styles from "./WalkerDiagram.module.css";

/*
 * Coordinates. The walker is drawn in a 320 x 380 box. On a wide stage, a label column of 120 units
 * sits on each side (the leader-line layer's box is 560 x 380, starting at x = -120), and each module's
 * hotspot is its label there. On a narrow stage, each hotspot is a 44px round marker on the part.
 * Both positions come from this one table, as percentages, so the HTML buttons line up with the SVG.
 */
export const DRAW_W = 320;
export const H = 380;
export const SIDE = 120;
export const WIDE_W = DRAW_W + 2 * SIDE;
const LABEL_GAP = 12;

// ---- Geometry: every part is a path, so each one can draw itself (pathLength = 1) ----
// Each stroke carries its length in drawing units, so the pen moves at an even speed.

interface Stroke {
  d: string;
  len: number;
}

const line = (x1: number, y1: number, x2: number, y2: number): Stroke => ({ d: `M${x1} ${y1} L${x2} ${y2}`, len: Math.hypot(x2 - x1, y2 - y1) });
const circle = (cx: number, cy: number, r: number): Stroke => ({
  d: `M${cx - r} ${cy} a${r} ${r} 0 1 0 ${2 * r} 0 a${r} ${r} 0 1 0 ${-2 * r} 0`,
  len: 2 * Math.PI * r,
});
function box(x: number, y: number, w: number, h: number, r: number): Stroke {
  return {
    d: `M${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} H${x + r} Q${x} ${y + h} ${x} ${y + h - r} V${y + r} Q${x} ${y} ${x + r} ${y} Z`,
    len: 2 * (w + h) - (8 - 2 * Math.PI) * r,
  };
}
function polyline(...points: [number, number][]): Stroke {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return { d: points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" "), len };
}

// Drawn in this order, like a person sketching it: the uprights, the bars, the grips, the wheels.
const FRAME: Stroke[] = [
  line(78, 74, 70, 318),
  line(242, 74, 250, 318),
  line(78, 132, 242, 132),
  line(74, 238, 246, 238),
  box(40, 54, 66, 20, 10),
  box(214, 54, 66, 20, 10),
  circle(70, 340, 20),
  circle(250, 340, 20),
  circle(70, 340, 3),
  circle(250, 340, 3),
  box(188, 252, 44, 26, 5), // the coordinator, under the front bar
  line(196, 265, 206, 265),
];

export const MODULES: Record<Exclude<ModuleId, "base.walker">, Stroke[]> = {
  // A pod with a large button on each grip.
  "controls.hand": [box(46, 48, 22, 32, 8), circle(57, 64, 5), box(252, 48, 22, 32, 8), circle(263, 64, 5)],
  // Microphone and speaker between the handles, with a grille.
  voice: [box(138, 104, 44, 36, 11), line(150, 116, 170, 116), line(150, 122, 170, 122), line(150, 128, 170, 128)],
  // Four sensors on the front bar, each with a lens.
  "perception.tof": [
    box(86, 242, 20, 13, 4),
    circle(96, 248.5, 2.5),
    box(116, 242, 20, 13, 4),
    circle(126, 248.5, 2.5),
    box(184, 242, 20, 13, 4),
    circle(194, 248.5, 2.5),
    box(214, 242, 20, 13, 4),
    circle(224, 248.5, 2.5),
  ],
  // An upright column at the front, with a carriage.
  "manipulation.lift": [box(152, 146, 16, 156, 5), line(152, 196, 168, 196), line(152, 204, 168, 204)],
  // Two arms off the carriage, each with a gripper.
  "manipulation.arm": [
    polyline([152, 200], [120, 182], [104, 206]),
    circle(120, 182, 3),
    polyline([98, 210], [104, 206], [110, 212]),
    polyline([168, 200], [200, 182], [216, 206]),
    circle(200, 182, 3),
    polyline([210, 212], [216, 206], [222, 210]),
  ],
  // A receiver clipped to the left upright, with an antenna.
  "location.gps": [box(58, 96, 14, 22, 4), line(65, 96, 65, 86), circle(65, 84, 2)],
};

export const MODULE_ORDER = MODULE_CATALOG.modules.map((m) => m.id).filter((id): id is keyof typeof MODULES => id !== "base.walker");

/** When each stroke starts and how long it takes, in seconds, at `speed` units a second. */
function timeline(strokes: Stroke[], speed: number, least = 0.07) {
  let at = 0;
  return strokes.map((st) => {
    const dur = Math.max(least, st.len / speed);
    const step = { ...st, at, dur };
    at += dur;
    return step;
  });
}

export const FRAME_START = 0.2;
/** Seconds the pen waits so it rides its line rather than leading it. */
const PEN_LAG = 0.06;
export const FRAME_STEPS = timeline(FRAME, 1150);
export const FRAME_END = FRAME_START + FRAME_STEPS.reduce((t, st) => t + st.dur, 0);
export const MODULE_STEPS = Object.fromEntries(MODULE_ORDER.map((id) => [id, timeline(MODULES[id], 560)])) as Record<keyof typeof MODULES, ReturnType<typeof timeline>>;

/**
 * The pen: a small nib that travels each stroke as it draws, in time with the line (SVG animateMotion,
 * started when it mounts). Hidden from assistive tech, and never shown under reduced motion.
 */
export function Pen({ steps, delay, tone }: { steps: ReturnType<typeof timeline>; delay: number; tone: "ink" | "live" }) {
  const ref = useRef<SVGCircleElement>(null);
  const total = steps.reduce((t, st) => t + st.dur, 0);
  useLayoutEffect(() => {
    // The lines start on the next style pass and the pen right now, so the pen waits a frame or two to stay on its line.
    ref.current?.querySelectorAll<SVGAnimationElement>("animateMotion, animate").forEach((a) => a.beginElementAt(delay + PEN_LAG + Number(a.dataset.at ?? 0)));
  }, [delay]);
  return (
    <circle ref={ref} className={styles.pen} data-tone={tone} r="3.4" opacity="0">
      {steps.map((st, i) => (
        <animateMotion key={i} data-at={st.at} dur={`${st.dur}s`} begin="indefinite" fill="freeze" path={st.d} />
      ))}
      <animate attributeName="opacity" data-at={0} dur={`${total + 0.15}s`} begin="indefinite" fill="freeze" values="0;1;1;0" keyTimes="0;0.04;0.93;1" />
    </circle>
  );
}

export interface Spot {
  id: ModuleId;
  /** Where the leader line ends, and where the narrow marker sits. */
  anchor: [number, number];
  side: "left" | "right";
  /** The label's vertical centre in the wide layout. */
  labelY: number;
}

// Spaced so that, at the smallest size the stage draws them, no two 44px targets overlap.
export const SPOTS: Spot[] = [
  { id: "controls.hand", anchor: [46, 64], side: "left", labelY: 64 },
  { id: "location.gps", anchor: [58, 107], side: "left", labelY: 140 },
  { id: "perception.tof", anchor: [86, 248], side: "left", labelY: 248 },
  { id: "base.walker", anchor: [50, 340], side: "left", labelY: 340 },
  { id: "voice", anchor: [182, 118], side: "right", labelY: 96 },
  { id: "manipulation.arm", anchor: [222, 210], side: "right", labelY: 196 },
  { id: "manipulation.lift", anchor: [168, 286], side: "right", labelY: 300 },
];

const pct = (n: number) => `${(n * 100).toFixed(3)}%`;
const labelEdge = (side: Spot["side"]) => (side === "left" ? -LABEL_GAP : DRAW_W + LABEL_GAP);

export function spotStyle(s: Spot): React.CSSProperties {
  return {
    "--wx": pct((labelEdge(s.side) + SIDE) / WIDE_W),
    "--wy": pct(s.labelY / H),
    "--nx": pct(s.anchor[0] / DRAW_W),
    "--ny": pct(s.anchor[1] / H),
  } as React.CSSProperties;
}

export function leader(s: Spot): string {
  const x0 = labelEdge(s.side);
  const elbow = s.side === "left" ? Math.min(s.anchor[0] - 12, x0 + 22) : Math.max(s.anchor[0] + 12, x0 - 22);
  return `M${x0} ${s.labelY} H${elbow} L${s.anchor[0]} ${s.anchor[1]}`;
}

/**
 * The dot beside a label: filled when on, a dashed ring when worth considering, a struck ring when the
 * person said no, a ring when off, a dotted ring when not available.
 */
export function StateDot({ state }: { state: PartState }) {
  return (
    <svg className={styles.dot} viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-state={state}>
      <circle cx="8" cy="8" r="5.5" />
      {state === "declined" ? <path d="M4.2 11.8L11.8 4.2" /> : null}
    </svg>
  );
}

/** The key under the drawing while the conversation runs: what solid, dashed and struck mean. Only the states on show. */
export function Legend({ states }: { states: Record<ModuleId, PartState> }) {
  const shown = (["on", "suggested", "declined"] as const).filter((st) => Object.entries(states).some(([id, v]) => id !== "base.walker" && v === st));
  if (shown.length === 0) return null;
  const words = { on: "Suggested", suggested: "Worth considering", declined: "You said no" } as const;
  return (
    <ul className={styles.legend} aria-hidden="true">
      {shown.map((st) => (
        <li key={st}>
          <StateDot state={st} />
          {words[st]}
        </li>
      ))}
    </ul>
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
  /** Said to screen readers in place of the drawing. */
  caption: string;
  /** Shown under the drawing: the first frame's line, or the legend. */
  note?: ReactNode;
}

/**
 * The walker seen from the front, as a fine line drawing: a schematic, not to scale. The frame draws
 * itself on load; a module draws in, with a warm glow, when it is on, and stays a faint dashed outline
 * when it isn't, so state never rests on colour alone. The drawing is hidden from screen readers: the
 * caption says the same in words, and in review each module is a real button that opens a small panel
 * with its switch. The module list beside it is an equal path for the same choices.
 */
export function WalkerDiagram({ recs, facts, states, review, problems, frozen, onToggle, highlight, onHighlight, caption, note }: WalkerDiagramProps) {
  const [open, setOpen] = useState<ModuleId | null>(null);
  const spotRefs = useRef(new Map<ModuleId, HTMLDivElement>());
  const buttonRefs = useRef(new Map<ModuleId, HTMLButtonElement>());
  const recById = new Map(recs.map((r) => [r.module_id, r]));
  const shown = review ? open : null;
  const reduced = useReducedMotion();
  // The pen starts when the page is live, so the lines wait for it rather than starting on first paint.
  const [live, setLive] = useState(false);
  useLayoutEffect(() => setLive(true), []);

  // When each lit part arrives (seconds from now) and a key that restarts its drawing. On mount, the
  // parts already lit arrive after the frame; later, the ones that just lit up arrive one at a time,
  // STAGGER apart, each with its name, so a room can read them. A part that's on is drawn by the pen.
  const [plan, setPlan] = useState<Partial<Record<ModuleId, { delay: number; key: number }>>>(() =>
    Object.fromEntries(MODULE_ORDER.filter((id) => isLit(states[id])).map((id, i) => [id, { delay: FRAME_END + 0.1 + i * STAGGER, key: 1 }])),
  );
  const previous = useRef(states);
  // A layout effect: the new plan lands before the paint that first shows the part lit.
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = states;
    const arrived = MODULE_ORDER.filter((id) => isLit(states[id]) && states[id] !== before[id]);
    if (arrived.length === 0) return;
    setPlan((p) => {
      const next = { ...p };
      arrived.forEach((id, i) => {
        next[id] = { delay: 0.15 + i * STAGGER, key: (p[id]?.key ?? 0) + 1 };
      });
      return next;
    });
  });

  // A press anywhere outside the open panel and its hotspot closes it, without moving focus. Escape
  // closes it from anywhere, also when it was opened by clicking the drawn part, and puts focus on the
  // part's button so the next Tab carries on from there.
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: PointerEvent) => {
      const spot = spotRefs.current.get(shown);
      if (spot && !spot.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setOpen(null);
      buttonRefs.current.get(shown)?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [shown]);

  function onKeyDown(e: KeyboardEvent, id: ModuleId) {
    if (e.key === "Escape" && shown === id) {
      e.preventDefault();
      setOpen(null);
      buttonRefs.current.get(id)?.focus();
    }
  }

  const lit = (id: ModuleId) => highlight === id || shown === id;
  // While the conversation runs, a label arrives with its part. In review the labels are buttons, there at once.
  const labelDelay = (id: ModuleId) => (review || id === "base.walker" ? 0 : (plan[id]?.delay ?? FRAME_END));
  // While the conversation runs, only what's lit is labelled; in review every module is.
  const labelled = (id: ModuleId) => review || (id !== "base.walker" && isLit(states[id]));

  return (
    <figure className={styles.figure} data-review={review || undefined} data-live={live || undefined}>
      <div className={styles.canvas}>
        <svg className={styles.leaders} viewBox={`${-SIDE} 0 ${WIDE_W} ${H}`} aria-hidden="true" focusable="false">
          {SPOTS.filter((s) => labelled(s.id)).map((s) => (
            <g key={s.id} className={styles.leader} data-state={states[s.id]} data-highlight={lit(s.id) || undefined}>
              <path d={leader(s)} pathLength={1} style={{ animationDelay: `${labelDelay(s.id)}s` }} />
              <circle cx={s.anchor[0]} cy={s.anchor[1]} r="2.5" style={{ animationDelay: `${labelDelay(s.id)}s` }} />
            </g>
          ))}
        </svg>

        <svg className={styles.drawing} viewBox={`0 0 ${DRAW_W} ${H}`} aria-hidden="true" focusable="false">
          <g className={styles.frame} data-highlight={lit("base.walker") || undefined} onClick={review ? () => setOpen("base.walker") : undefined}>
            {FRAME_STEPS.map((st, i) => (
              <path key={i} d={st.d} pathLength={1} style={{ "--at": `${FRAME_START + st.at}s`, "--dur": `${st.dur}s` } as React.CSSProperties} />
            ))}
          </g>
          {MODULE_ORDER.map((id) => (
            <g
              key={id}
              className={styles.part}
              data-state={states[id]}
              data-highlight={lit(id) || undefined}
              data-clickable={review || undefined}
              style={{ "--delay": `${plan[id]?.delay ?? 0}s` } as React.CSSProperties}
              // A bonus for pointer users: the drawn part opens the same panel as its hotspot button.
              onClick={review ? () => setOpen((o) => (o === id ? null : id)) : undefined}
              onPointerEnter={review ? () => onHighlight(id) : undefined}
              onPointerLeave={review ? () => onHighlight(null) : undefined}
            >
              <g className={styles.ghost}>
                {MODULES[id].map((st, i) => (
                  <path key={i} d={st.d} />
                ))}
              </g>
              {/* Keyed by when it last turned on, so the ink draws in again each time. */}
              <g key={plan[id]?.key ?? 0} className={styles.ink}>
                {MODULE_STEPS[id].map((st, i) => (
                  <path key={i} d={st.d} pathLength={1} style={{ "--at": `${st.at}s`, "--dur": `${st.dur}s` } as React.CSSProperties} />
                ))}
              </g>
            </g>
          ))}
          {reduced || !live ? null : (
            <>
              <Pen steps={FRAME_STEPS} delay={FRAME_START} tone="ink" />
              {MODULE_ORDER.filter((id) => states[id] === "on" && plan[id]).map((id) => (
                <Pen key={`${id}-${plan[id]!.key}`} steps={MODULE_STEPS[id]} delay={plan[id]!.delay} tone="live" />
              ))}
            </>
          )}
        </svg>

        {SPOTS.map((s) => {
          if (!labelled(s.id)) return null;
          const entry = getCatalogEntry(MODULE_CATALOG, s.id);
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
              style={{ ...spotStyle(s), "--label-delay": `${labelDelay(s.id)}s` } as React.CSSProperties}
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
                  // Said in full here: the state is a dot on screen, and the name is hidden on narrow screens.
                  aria-label={`${entry.name}, ${label}`}
                  aria-expanded={isOpen}
                  aria-controls={isOpen ? panelId : undefined}
                  onClick={() => setOpen(isOpen ? null : s.id)}
                  onPointerEnter={() => onHighlight(s.id)}
                  onPointerLeave={() => onHighlight(null)}
                  onFocus={() => onHighlight(s.id)}
                  onBlur={() => onHighlight(null)}
                >
                  <StateDot state={states[s.id]} />
                  <span className={styles.spotText}>
                    <span className={styles.spotName}>{entry.name}</span>
                    {states[s.id] === "unavailable" || states[s.id] === "declined" ? <span className={styles.spotState}>{label}</span> : null}
                  </span>
                </button>
              ) : (
                <span className={styles.hotspot} data-state={states[s.id]} aria-hidden="true">
                  <StateDot state={states[s.id]} />
                  <span className={styles.spotText}>
                    <span className={styles.spotName}>{entry.name}</span>
                    {states[s.id] === "declined" ? <span className={styles.spotState}>{label}</span> : null}
                  </span>
                </span>
              )}
              {isOpen ? (
                <ModulePanel
                  id={s.id}
                  panelId={panelId}
                  rec={recById.get(s.id)}
                  facts={facts}
                  state={states[s.id]}
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
      <figcaption className="visually-hidden">{caption}</figcaption>
      {note ? (
        <div className={styles.note} aria-hidden="true">
          {note}
        </div>
      ) : null}
    </figure>
  );
}

/**
 * The small glass panel next to a hotspot. The person's own words come first, large enough to read from
 * across a room, then the rule's reason, then what the part does, then its switch. A part they said no
 * to says so, with the words they said it in.
 */
function ModulePanel({
  id,
  panelId,
  rec,
  facts,
  state,
  problem,
  frozen,
  onToggle,
  onClose,
}: {
  id: ModuleId;
  panelId: string;
  rec: Recommendation | undefined;
  facts: readonly ProfileFact[];
  state: PartState;
  problem: SelectionProblem | null;
  frozen: string | null;
  onToggle(id: ModuleId, on: boolean): void;
  onClose(): void;
}) {
  const entry = getCatalogEntry(MODULE_CATALOG, id);
  const why = whySuggested(rec, facts);
  const locked = lockReason(entry) ?? frozen;
  const on = state === "on";
  return (
    <div id={panelId} className={styles.panel} role="group" aria-labelledby={`${panelId}-title`} data-declined={why?.declined || undefined}>
      <div className={styles.panelHead}>
        <h3 id={`${panelId}-title`} className={styles.panelTitle}>
          {entry.name}
          {why?.declined && !on ? (
            <>
              <span className="visually-hidden">, </span>
              <span className={styles.panelNo}>You said no</span>
            </>
          ) : null}
        </h3>
        <button type="button" className={styles.close} onClick={onClose} aria-label={`Close ${nameOf(id)}`}>
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M6 6l8 8M14 6l-8 8" />
          </svg>
        </button>
      </div>
      {why?.said ? (
        <figure className={styles.said}>
          <figcaption className={styles.saidLead}>{why.said.lead}:</figcaption>
          <blockquote className={styles.saidText}>
            <p>{why.said.text}</p>
          </blockquote>
        </figure>
      ) : null}
      {why ? <p className={styles.panelWhy}>{why.declined ? why.reason : `Why it's suggested: ${why.reason}`}</p> : null}
      <p className={styles.panelText}>{entry.summary}</p>
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
        ) : null}
      </div>
    </div>
  );
}
