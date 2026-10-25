"use client";

import { useEffect, useState } from "react";
import { preload } from "react-dom";
import styles from "./Intro.module.css";

const BANNER = "/brand/sophi-banner.webp";

/**
 * The opening: the Sophi wordmark alone, then the walker comes in beside it, then the whole card fades
 * into the page. It runs on CSS alone, so it plays from the server's HTML before the page is live, and
 * ends hidden even if the script never runs. A click or any key skips it. Under reduced motion the full
 * banner shows still for a moment and fades. Hidden from screen readers: the header says the same.
 */
export function Intro() {
  // Fetched with the page's HTML, so the wordmark is there when its fade starts.
  preload(BANNER, { as: "image", fetchPriority: "high" });
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (gone) return;
    const skip = () => setGone(true);
    window.addEventListener("keydown", skip);
    return () => window.removeEventListener("keydown", skip);
  }, [gone]);
  if (gone) return null;
  return (
    <div
      className={styles.intro}
      aria-hidden="true"
      onClick={() => setGone(true)}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setGone(true);
      }}
    >
      <div className={styles.banner}>
        <img className={styles.word} src={BANNER} alt="" />
        <img className={styles.whole} src={BANNER} alt="" />
      </div>
    </div>
  );
}
