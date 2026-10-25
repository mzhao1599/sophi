"use client";

/**
 * What a caretaker's phone does when a new request for help arrives while the app is open (docs/subsystems/help.md,
 * "The phones"): a short two-note tone and a vibration where the browser has them. Neither is the only signal: the
 * card, its words and the live-region line carry it. A browser may block audio until the page has had a tap, and
 * iOS Safari has no `navigator.vibrate`; either way nothing throws and nothing else changes.
 */

let context: AudioContext | null = null;

/** Two soft notes, 660 Hz then 880 Hz, 180 ms each: noticeable, not an alarm. */
export function playHelpTone(): void {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    context ??= new Ctor();
    const ctx = context;
    void ctx.resume?.().catch(() => undefined);
    const start = ctx.currentTime + 0.02;
    [660, 880].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = start + i * 0.22;
      osc.type = "sine";
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  } catch {
    // Blocked or unsupported: the card and its words are the alert.
  }
}

/** One short buzz pattern where the browser can vibrate. */
export function buzz(): void {
  try {
    navigator.vibrate?.([200, 100, 200]);
  } catch {
    // Not allowed here: nothing to do.
  }
}

/** Lets the first tap anywhere unlock audio, so a later tone can play (browsers start audio only after a gesture). */
export function unlockAudioOnFirstTap(): () => void {
  const unlock = () => {
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      context ??= new Ctor();
      void context.resume?.().catch(() => undefined);
    } catch {
      // Unsupported: the tone just won't play.
    }
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}
