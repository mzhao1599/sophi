"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { WalkerStatusView } from "@walker/contracts";
import { CAPTION, INK_STAGGER_MS, NOTHING_YET, NO_TIMINGS, buildStages, formatMs, type Stage } from "@/lib/behindTheScenes";
import { useReducedMotion } from "@/lib/motion";
import type { WalkerPage } from "@/lib/useWalkerPage";
import styles from "./BehindTheScenes.module.css";

/**
 * "Behind the scenes": the latest turn as a survey traverse. Each step the server reports is a trig point
 * (a triangle with a dot) and the pen inks the line to it when its evidence reaches the page. Several
 * steps arriving in one poll ink one after another, INK_STAGGER_MS apart, but every figure printed is
 * the server's own measurement. The finished turn stays drawn until the next turn replaces it.
 *
 * Not a live region: the page's one polite region already reads each reply once. A labelled, focusable
 * region with an ordered list, one sentence per step. Reduced motion: everything appears at once.
 * The drawing uses CSS transitions on SVG stroke-dashoffset only; nothing runs an animation-frame loop.
 */
export function BehindTheScenes({ page, walker }: { page: WalkerPage; walker: WalkerStatusView }) {
  const reduced = useReducedMotion();
  const ids = useId();
  const view = buildStages({
    status: walker,
    activity: page.activity.find((a) => a.device_id === walker.device_id),
    card: page.card,
    ownTurnId: page.sendingTurnId,
    nowMs: page.serverNow(),
  });
  const inked = useInk(view.key, view.stages, reduced);

  const meta = [view.title, view.totalMs !== null ? `whole turn ${formatMs(view.totalMs)}` : null, view.timing === "none" ? NO_TIMINGS : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className={styles.panel} aria-labelledby={`${ids}-title`} tabIndex={0}>
      <div className={styles.head}>
        <h2 id={`${ids}-title`} className={styles.title}>
          Behind the scenes
        </h2>
        {view.key ? <p className={styles.meta}>{meta}</p> : null}
        <p className={styles.caption}>{CAPTION}</p>
      </div>
      {view.stages.length === 0 ? (
        <p className={styles.empty}>{NOTHING_YET}</p>
      ) : (
        <ol key={view.key} className={styles.traverse} data-reduced={reduced || undefined}>
          {view.stages.map((s, i) => {
            const next = view.stages[i + 1];
            return (
              <li
                key={s.id}
                className={styles.station}
                data-state={s.state}
                data-inked={inked.has(s.id) || undefined}
                data-first={i === 0 || undefined}
              >
                <span className="visually-hidden">{s.sentence}</span>
                {next ? <Segment drawn={inked.has(next.id)} to={next} /> : null}
                <svg className={styles.mark} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  {s.state === "live" ? <circle className={styles.ring} cx="12" cy="14" r="8" /> : null}
                  <path className={styles.trig} d="M12 3.5 L21 19.5 H3 Z" pathLength={1} />
                  {s.state === "end" ? null : <circle className={styles.dot} cx="12" cy="14" r="2.3" />}
                </svg>
                <span className={styles.words} aria-hidden="true">
                  <span className={styles.label}>{s.label}</span>
                  <span className={styles.figure}>{s.figure}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/**
 * The line from one station to the next, inked when the next one is. Solid toward a finished step,
 * dashed toward a step still waiting, dotted toward an end; the words say the same. Drawn through a
 * mask whose stroke-dashoffset runs from 1 to 0, so a dashed line draws in like a solid one.
 */
function Segment({ drawn, to }: { drawn: boolean; to: Stage }) {
  const mask = useId();
  const style = to.state === "live" ? "dashed" : to.state === "end" ? "dotted" : "solid";
  return (
    <span className={styles.segment} data-drawn={drawn || undefined} data-style={style} aria-hidden="true">
      <svg className={styles.across} focusable="false">
        <mask id={`${mask}-h`} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <line className={styles.reveal} x1="0" y1="50%" x2="100%" y2="50%" pathLength={1} />
        </mask>
        <line className={styles.line} x1="0" y1="50%" x2="100%" y2="50%" mask={`url(#${mask}-h)`} />
      </svg>
      <svg className={styles.down} focusable="false">
        <mask id={`${mask}-v`} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <line className={styles.reveal} x1="50%" y1="0" x2="50%" y2="100%" pathLength={1} />
        </mask>
        <line className={styles.line} x1="50%" y1="0" x2="50%" y2="100%" mask={`url(#${mask}-v)`} />
      </svg>
      <span className={styles.nib} />
    </span>
  );
}

/**
 * Which stations are inked. A station is inked once its evidence is here: new ones one after another,
 * INK_STAGGER_MS apart, in order; all at once with reduced motion. A new turn (a new key) starts over.
 */
function useInk(key: string | null, stages: readonly Stage[], reduced: boolean): Set<string> {
  const [inked, setInked] = useState<{ key: string | null; ids: Set<string> }>({ key, ids: new Set() });
  const queued = useRef<{ key: string | null; ids: Set<string>; timers: ReturnType<typeof setTimeout>[] }>({ key, ids: new Set(), timers: [] });
  const order = stages.map((s) => s.id).join(" ");

  useEffect(() => {
    const q = queued.current;
    if (q.key !== key) {
      q.timers.forEach(clearTimeout);
      queued.current = { key, ids: new Set(), timers: [] };
    }
    const now = queued.current;
    const fresh = order.split(" ").filter((id) => id && !now.ids.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => now.ids.add(id));
    if (reduced) {
      setInked((s) => ({ key, ids: new Set([...(s.key === key ? s.ids : []), ...fresh]) }));
      return;
    }
    // A frame after mount, so each newly mounted station transitions from undrawn to drawn.
    fresh.forEach((id, i) => {
      now.timers.push(setTimeout(() => setInked((s) => ({ key, ids: new Set([...(s.key === key ? s.ids : []), id]) })), 30 + i * INK_STAGGER_MS));
    });
  }, [key, order, reduced]);

  useEffect(() => () => queued.current.timers.forEach(clearTimeout), []);

  return inked.key === key ? inked.ids : new Set();
}
