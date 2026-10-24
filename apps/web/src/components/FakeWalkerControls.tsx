"use client";

import { useState } from "react";
import type { FakeFailure, FakeWalkerControls } from "@/lib/walkerFake";
import styles from "./Walker.module.css";

const FAILURES: FakeFailure[] = [
  "network",
  "unauthenticated",
  "not_found",
  "proposal_closed",
  "walker_limit",
  "pairing_locked",
  "rate_limited",
  "invalid_request",
  "unavailable",
];

/** The demo script's spoken lines (docs/demo/walker-script.md), for a Talk press on the fake walker. */
const TALK_LINES = ["What can you help me with?", "Stop buzzing me, use short sounds instead.", "Can you pick up my keys?"];

/**
 * Development only: plays the walker's side of the development fake, so every state of the page can be
 * reached by keyboard in the browser. Never rendered with the real API.
 */
export function FakeControls({ controls, onChange }: { controls: FakeWalkerControls; onChange(): void }) {
  const [failure, setFailure] = useState<FakeFailure>("network");
  const [note, setNote] = useState("");
  const s = controls.snapshot();
  const act = (label: string, run: () => boolean | void) => () => {
    const ok = run();
    setNote(ok === false ? `${label}: nothing to do.` : `${label}: done.`);
    onChange();
  };
  return (
    <details className={styles.fakeControls}>
      <summary>Fake walker controls</summary>
      <div className={styles.fakeBody}>
        <button type="button" onClick={act("Pair from the walker", () => controls.pairFromWalker())}>
          Walker: pair with the code on screen
        </button>
        <button type="button" onClick={act("Walker line", () => controls.walkerSays("A part stopped responding: hand controls.", "notice"))}>
          Walker: say a notice
        </button>
        <div className={styles.fakeRow}>
          <button type="button" onClick={act("Offline", () => controls.setOnline(false))}>
            Walker: go offline
          </button>
          <button type="button" onClick={act("Online", () => controls.setOnline(true))}>
            Walker: come back online
          </button>
        </div>
        <button
          type="button"
          onClick={act("Offline Talk press", () => controls.walkerSays("I'm offline right now. Your vibration alerts still work.", "local_reply"))}
        >
          Walker: Talk press while offline
        </button>
        {TALK_LINES.map((line) => (
          <button key={line} type="button" onClick={act("Talk on the walker", () => controls.walkerTalks(line))}>
            Walker: Talk, &ldquo;{line}&rdquo;
          </button>
        ))}
        <button type="button" onClick={act("Confirm on the walker", () => controls.confirmOnWalker())}>
          Walker: press Confirm
        </button>
        <button type="button" onClick={act("Offer expires in 5 s", () => controls.expireSoon(5))}>
          Offer: expire in 5 seconds
        </button>
        <div className={styles.fakeRow}>
          <button type="button" onClick={act("Simulator off", () => controls.setSimulator(false))}>
            Real parts
          </button>
          <button type="button" onClick={act("Simulator on", () => controls.setSimulator(true))}>
            Simulator
          </button>
        </div>
        <div className={styles.fakeRow}>
          <button type="button" onClick={act("Sensors unplugged", () => controls.setSensorsPlugged(false))}>
            Unplug sensors
          </button>
          <button type="button" onClick={act("Sensors plugged in", () => controls.setSensorsPlugged(true))}>
            Plug sensors in
          </button>
        </div>
        <div className={styles.fakeRow}>
          <button type="button" onClick={act("Server down", () => controls.setServerDown(true))}>
            Server: go down
          </button>
          <button type="button" onClick={act("Server back", () => controls.setServerDown(false))}>
            Server: come back
          </button>
        </div>
        <button type="button" onClick={act("Cookie cleared", () => controls.clearCookie())}>
          Browser: lose the owner cookie
        </button>
        <label>
          Next request fails with{" "}
          <select value={failure} onChange={(e) => setFailure(e.target.value as FakeFailure)}>
            {FAILURES.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <button type="button" onClick={act(`Next request fails with ${failure}`, () => controls.failNext(failure))}>
          Arm that failure
        </button>
        <p>
          Walkers {s.paired} · {s.online ? "online" : "offline"} · code {s.codeLive ? "live" : "none"} · offer {s.proposalOpen ? "open" : "none"}
          {s.pendingFailure ? ` · next fails: ${s.pendingFailure}` : ""}
        </p>
        <p aria-live="polite">{note}</p>
      </div>
    </details>
  );
}
