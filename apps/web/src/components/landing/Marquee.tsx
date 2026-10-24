"use client";

import { useState } from "react";
import styles from "./Landing.module.css";

/**
 * The page's one moving line. The words are said once to screen readers; the moving copies are
 * hidden from them. Moving text that runs for more than five seconds needs a way to stop it
 * (WCAG 2.2.2), so the band has a real pause button. It also stops on hover and never moves under
 * reduced motion, where the button is not needed and is hidden.
 */
export function Marquee({ words }: { words: string }) {
  const [paused, setPaused] = useState(false);
  const copies = Array.from({ length: 4 }, (_, i) => (
    <span key={i} className={styles.marqueeCopy}>
      {words}
      <span className={styles.marqueeDot} />
    </span>
  ));

  return (
    <div className={styles.marquee} data-paused={paused || undefined}>
      <p className="visually-hidden">{words}</p>
      <div className={styles.marqueeTrack} aria-hidden="true">
        <div className={styles.marqueeRun}>{copies}</div>
        <div className={styles.marqueeRun}>{copies}</div>
      </div>
      <button type="button" className={styles.marqueeToggle} onClick={() => setPaused((p) => !p)}>
        {paused ? "Play the moving words" : "Pause the moving words"}
      </button>
    </div>
  );
}
