"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModuleId } from "@walker/contracts";
import { useReducedMotion } from "@/lib/motion";
import { drawnParts, spreadLabels, type DrawState, type PartRow } from "@/lib/walkerView";
import {
  DRAW_W,
  FRAME_END,
  FRAME_START,
  FRAME_STEPS,
  H,
  MODULES,
  MODULE_ORDER,
  MODULE_STEPS,
  Pen,
  SIDE,
  SPOTS,
  STAGGER,
  WIDE_W,
  leader,
  spotStyle,
} from "./WalkerDiagram";
import page from "./Walker.module.css";
import styles from "./WalkerDiagram.module.css";

/** States drawn in ink by the pen; the others are outlines. */
const INKED: readonly DrawState[] = ["on", "degraded"];

/**
 * The walker as it reports itself now, in the same pen-drawn style as onboarding (the geometry and
 * styles of WalkerDiagram). The frame draws itself, then each reported part arrives one at a time with
 * its name and state: solid green ink only for a real, healthy part; dashed green for a simulated one;
 * ink for degraded; red dashes for a fault; a faint dotted outline when unavailable. Parts the walker
 * doesn't have aren't drawn. Hidden from screen readers: the caption and the parts list say the same in
 * words. Labels show from 560px wide; narrower, the parts list beside it carries the words.
 */
export const LiveWalkerDiagram = memo(function LiveWalkerDiagram({ rows, caption }: { rows: readonly PartRow[]; caption: string }) {
  const reduced = useReducedMotion();
  const [live, setLive] = useState(false);
  useLayoutEffect(() => setLive(true), []);

  // One place per module on the drawing; parts of the same module show their worst state.
  const byId = drawnParts(rows);
  const state = new Map<ModuleId, DrawState>([...byId].map(([id, d]) => [id, d.draw]));

  // When each part arrives and a key that restarts its drawing: after the frame on mount, then one at a
  // time, STAGGER apart, whenever a part changes state, so a room can read each one with its name.
  const [plan, setPlan] = useState<Partial<Record<ModuleId, { delay: number; key: number }>>>(() =>
    Object.fromEntries(MODULE_ORDER.filter((id) => state.has(id)).map((id, i) => [id, { delay: FRAME_END + 0.1 + i * STAGGER, key: 1 }])),
  );
  const previous = useRef(state);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = state;
    const changed = MODULE_ORDER.filter((id) => state.has(id) && state.get(id) !== before.get(id));
    if (changed.length === 0) return;
    setPlan((p) => {
      const next = { ...p };
      changed.forEach((id, i) => {
        next[id] = { delay: 0.15 + i * STAGGER, key: (p[id]?.key ?? 0) + 1 };
      });
      return next;
    });
  });

  // Labels arrive with their parts on first load. After that a label that reappears (a resize or zoom
  // across 560px restarts its entrance) shows at once rather than waiting out its first-load delay.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSettled(true), (FRAME_END + 0.5 + MODULE_ORDER.length * STAGGER) * 1000);
    return () => clearTimeout(t);
  }, []);
  const delayOf = (id: ModuleId) => (settled ? 0 : id === "base.walker" ? FRAME_END : (plan[id]?.delay ?? FRAME_END));
  const shown = SPOTS.filter((s) => state.has(s.id));

  // Each label starts level with its part. The drawing can be as short as 240px while a label with its
  // states runs to several lines, so measure the labels and move them apart until none overlap; the
  // leader lines follow. Again whenever the drawing or a label changes size.
  const canvasRef = useRef<HTMLDivElement>(null);
  const spotEls = useRef(new Map<ModuleId, HTMLDivElement>());
  const [labelY, setLabelY] = useState<Partial<Record<ModuleId, number>>>({});
  const shownIds = shown.map((s) => s.id).join();
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ids = shownIds.split(",");
    const place = () => {
      if (canvas.offsetHeight === 0) return;
      const unit = H / canvas.offsetHeight;
      const next: Partial<Record<ModuleId, number>> = {};
      for (const side of ["left", "right"] as const) {
        const spots = SPOTS.filter((s) => s.side === side && ids.includes(s.id));
        const at = spreadLabels(spots.map((s) => ({ want: s.labelY, size: (spotEls.current.get(s.id)?.offsetHeight ?? 0) * unit })), 0, H);
        spots.forEach((s, i) => (next[s.id] = at[i]));
      }
      setLabelY((was) => (Object.keys(next).every((id) => Math.abs((was[id as ModuleId] ?? -1) - next[id as ModuleId]!) < 0.05) ? was : next));
    };
    place();
    const watch = new ResizeObserver(place);
    watch.observe(canvas);
    spotEls.current.forEach((el) => watch.observe(el));
    return () => watch.disconnect();
  }, [shownIds]);
  const placed = shown.map((s) => ({ ...s, labelY: labelY[s.id] ?? s.labelY }));

  return (
    <figure className={styles.figure} data-variant="live" data-live={live || undefined}>
      <div ref={canvasRef} className={styles.canvas}>
        <svg className={styles.leaders} viewBox={`${-SIDE} 0 ${WIDE_W} ${H}`} aria-hidden="true" focusable="false">
          {placed.map((s) => (
            <g key={s.id} className={styles.leader} data-state={state.get(s.id)}>
              <path d={leader(s)} pathLength={1} style={{ animationDelay: `${delayOf(s.id)}s` }} />
              <circle cx={s.anchor[0]} cy={s.anchor[1]} r="2.5" style={{ animationDelay: `${delayOf(s.id)}s` }} />
            </g>
          ))}
        </svg>

        <svg className={styles.drawing} viewBox={`0 0 ${DRAW_W} ${H}`} aria-hidden="true" focusable="false">
          <g className={styles.frame}>
            {FRAME_STEPS.map((st, i) => (
              <path key={i} d={st.d} pathLength={1} style={{ "--at": `${FRAME_START + st.at}s`, "--dur": `${st.dur}s` } as React.CSSProperties} />
            ))}
          </g>
          {MODULE_ORDER.filter((id) => state.has(id)).map((id) => (
            <g key={id} className={styles.part} data-state={state.get(id)} style={{ "--delay": `${plan[id]?.delay ?? 0}s` } as React.CSSProperties}>
              <g className={styles.ghost}>
                {MODULES[id].map((st, i) => (
                  <path key={i} d={st.d} />
                ))}
              </g>
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
              {MODULE_ORDER.filter((id) => INKED.includes(state.get(id) as DrawState) && plan[id]).map((id) => (
                <Pen key={`${id}-${plan[id]!.key}`} steps={MODULE_STEPS[id]} delay={plan[id]!.delay} tone={state.get(id) === "on" ? "live" : "ink"} />
              ))}
            </>
          )}
        </svg>

        {placed.map((s) => (
          <div
            key={s.id}
            ref={(el) => {
              if (el) spotEls.current.set(s.id, el);
              else spotEls.current.delete(s.id);
            }}
            className={styles.spot}
            data-side={s.side}
            style={{ ...spotStyle(s), "--label-delay": `${delayOf(s.id)}s` } as React.CSSProperties}
          >
            <span className={styles.hotspot} data-state={state.get(s.id)} aria-hidden="true">
              <svg className={styles.dot} viewBox="0 0 16 16" aria-hidden="true" focusable="false" data-state={state.get(s.id)}>
                <circle cx="8" cy="8" r="5.5" />
              </svg>
              <span className={styles.spotText}>
                <span className={styles.spotName}>{byId.get(s.id)!.name}</span>
                <span className={styles.spotState}>{byId.get(s.id)!.words}</span>
                {byId.get(s.id)!.simulated ? (
                  <span className={page.tag} style={{ justifySelf: s.side === "left" ? "end" : "start" }}>
                    Simulated
                  </span>
                ) : null}
              </span>
            </span>
          </div>
        ))}
      </div>
      <figcaption className="visually-hidden">{caption}</figcaption>
    </figure>
  );
});
