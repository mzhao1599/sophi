"use client";

import { useEffect, useRef, useState } from "react";
import { CAMERA_FRAME_STALE_MS, CAMERA_WATCH_MAX_MS, type CameraStatusView } from "@walker/contracts";
import type { CameraApi } from "@/lib/cameraApi";
import type { LiveFrame } from "@/lib/cameraStream";
import { PhoneApiError } from "@/lib/phoneApi";
import styles from "./Phone.module.css";

/** How often a phone asks whether the camera is shared and who is watching. */
const STATUS_EVERY_MS = 3_000;

/** "Maya", "Maya and Sam", "Maya, Sam and Jo". */
function listNames(names: string[]): string {
  return new Intl.ListFormat("en", { type: "conjunction" }).format(names);
}

/** The camera's status, asked every STATUS_EVERY_MS while the tab is visible; null until the first answer. */
export function useCameraStatus(camera: CameraApi): { status: CameraStatusView | null; reload(): Promise<void> } {
  const [status, setStatus] = useState<CameraStatusView | null>(null);
  const reload = useRef(async () => {});
  useEffect(() => {
    let live = true;
    const ask = new AbortController();
    reload.current = async () => {
      try {
        const next = await camera.status(ask.signal);
        if (live) setStatus(next);
      } catch {
        // A failed ask keeps the last answer; the next tick tries again.
      }
    };
    void reload.current();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload.current();
    }, STATUS_EVERY_MS);
    return () => {
      live = false;
      ask.abort();
      clearInterval(timer);
    };
  }, [camera]);
  return { status, reload: () => reload.current() };
}

/** On her phone, on every screen: who is watching her camera right now. Nothing while nobody is. */
export function CameraWatchingLine({ camera }: { camera: CameraApi }) {
  const { status } = useCameraStatus(camera);
  const names = status?.sharing ? status.watching.map((w) => w.name) : [];
  return (
    <p className={styles.cameraWatching} role="status" hidden={names.length === 0}>
      {names.length ? `${listNames(names)} ${names.length === 1 ? "is" : "are"} watching your walker's camera now.` : ""}
    </p>
  );
}

/** Her phone: turn camera sharing on or off. Like location sharing, it starts off and turning it on is her own tap. */
export function CameraSharing({ camera, announce }: { camera: CameraApi; announce(text: string): void }) {
  const { status, reload } = useCameraStatus(camera);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sharing = status?.sharing === true;
  async function change() {
    if (changing || !status) return;
    setChanging(true);
    setError(null);
    try {
      await camera.setSharing(!sharing);
      await reload();
      announce(!sharing ? "Camera sharing is on." : "Camera sharing is off. Nobody can watch now.");
    } catch {
      setError("Couldn't change camera sharing. Try again.");
    } finally {
      setChanging(false);
    }
  }
  const watching = status?.watching.map((w) => w.name) ?? [];
  return (
    <section className={styles.card} aria-labelledby="camera-sharing-title">
      <h2 id="camera-sharing-title" className={styles.cardTitle}>Camera sharing</h2>
      <p>Approved caretakers can watch your walker's camera live, only while this is on. You'll see here who is watching. Nothing is recorded.</p>
      <p>{status === null ? "Checking…" : sharing ? (watching.length ? `Sharing is on. ${listNames(watching)} ${watching.length === 1 ? "is" : "are"} watching now.` : "Sharing is on. Nobody is watching.") : "Sharing is off."}</p>
      {status && !status.walker_camera ? <p className={styles.meta}>Your walker's camera isn't connected right now.</p> : null}
      <button type="button" className={styles.primary} aria-pressed={sharing} aria-disabled={changing || status === null || undefined} onClick={() => void change()}>
        {changing ? "Changing…" : sharing ? "Stop sharing my camera" : "Share my camera with approved caretakers"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

type Watch =
  | { phase: "idle"; ended: string | null }
  | { phase: "watching"; since: number };

/** What the picture area says, from the newest frame's arrival. */
function pictureLine(frameAt: number | null, now: number): { live: boolean; line: string } {
  if (frameAt === null) return { live: false, line: "Waiting for the walker's camera…" };
  const age = now - frameAt;
  if (age <= CAMERA_FRAME_STALE_MS) return { live: true, line: "Live" };
  return { live: false, line: `No new picture for ${Math.floor(age / 1_000)} seconds` };
}

/** A caretaker's phone: watch her walker's camera while she shares it. */
export function CameraWatch({ camera, herName, announce }: { camera: CameraApi; herName: string; announce(text: string): void }) {
  const { status, reload } = useCameraStatus(camera);
  const [watch, setWatch] = useState<Watch>({ phase: "idle", ended: null });
  const [picture, setPicture] = useState<{ url: string; at: number; source: LiveFrame["source"] } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const stop = useRef<AbortController | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const wasLive = useRef(false);

  // The picture's age is read every half second while watching; the page never claims "Live" for an old frame.
  useEffect(() => {
    if (watch.phase !== "watching") return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [watch.phase]);
  useEffect(() => () => stop.current?.abort(), []);
  // The pressed button goes away when the watch starts or ends, so focus moves to the one that replaces it.
  const lastPhase = useRef(watch.phase);
  useEffect(() => {
    if (lastPhase.current === watch.phase) return;
    lastPhase.current = watch.phase;
    button.current?.focus();
  }, [watch.phase]);
  useEffect(() => () => {
    if (picture) URL.revokeObjectURL(picture.url);
  }, [picture]);

  const state = pictureLine(watch.phase === "watching" ? (picture?.at ?? null) : null, now);
  // Said once when the picture goes still or comes back, never per frame.
  useEffect(() => {
    if (watch.phase !== "watching" || picture === null) return;
    if (state.live !== wasLive.current) announce(state.live ? "The live picture is showing." : "No new picture from the walker.");
    wasLive.current = state.live;
  }, [state.live, watch.phase, picture, announce]);

  async function start() {
    if (watch.phase === "watching") return;
    const controller = new AbortController();
    stop.current = controller;
    wasLive.current = false;
    setPicture(null);
    setWatch({ phase: "watching", since: Date.now() });
    announce(`Watching ${herName}'s walker camera.`);
    let ended: string;
    try {
      await camera.watch((frame) => {
        const url = URL.createObjectURL(new Blob([frame.jpeg as BlobPart], { type: "image/jpeg" }));
        setPicture({ url, at: Date.now() - frame.ageMs, source: frame.source });
      }, controller.signal);
      ended = controller.signal.aborted ? "You stopped watching." : await endedLine();
    } catch (error) {
      if (controller.signal.aborted) ended = "You stopped watching.";
      else if (error instanceof PhoneApiError && error.code === "not_allowed") ended = `${herName}'s camera sharing is off.`;
      else ended = "The live picture stopped. Try again.";
    }
    if (stop.current === controller) stop.current = null;
    setWatch({ phase: "idle", ended });
    setPicture(null);
    announce(ended);
    void reload();
  }

  /** Why the server ended the stream: sharing off, or the watch's time limit. */
  async function endedLine(): Promise<string> {
    try {
      const next = await camera.status();
      if (!next.sharing) return `${herName} turned camera sharing off.`;
    } catch {
      return "The live picture stopped. Try again.";
    }
    return `Stopped after ${CAMERA_WATCH_MAX_MS / 60_000} minutes. Watch again any time.`;
  }

  const canWatch = status?.can_watch === true && status.walker_camera;
  const source = picture?.source ?? status?.source ?? null;
  return (
    <section className={styles.card} aria-labelledby="camera-title">
      <div className={styles.titleRow}>
        <h2 id="camera-title" className={styles.cardTitle}>{herName}'s walker camera</h2>
        {source === "test_pattern" ? <span className={styles.tag}>Test pattern</span> : null}
      </div>
      {watch.phase === "watching" ? (
        <>
          <div className={styles.cameraFrame} data-live={state.live}>
            {picture ? (
              <img src={picture.url} alt={source === "test_pattern" ? "Test pattern from the walker simulator, not a camera picture" : `Live picture from the camera on ${herName}'s walker`} />
            ) : null}
          </div>
          <p className={styles.presence}>
            <span className={styles.dot} data-online={state.live} aria-hidden="true" />
            {state.line}
          </p>
          {source === "test_pattern" ? <p className={styles.meta}>Test pattern from the walker simulator, not a camera.</p> : null}
          <p className={styles.meta}>{herName} sees that you are watching. Nothing is recorded.</p>
          <button ref={button} type="button" className={styles.secondary} onClick={() => stop.current?.abort()}>
            Stop watching
          </button>
        </>
      ) : (
        <>
          {watch.ended ? <p>{watch.ended}</p> : null}
          <p>
            {status === null
              ? "Checking…"
              : !status.sharing
                ? `Camera sharing is off. Only ${herName} can turn it on, from her phone.`
                : !status.walker_camera
                  ? `${herName} shares her camera, but the walker's camera isn't connected right now.`
                  : `${herName} shares her walker's camera with you.`}
          </p>
          <button ref={button} type="button" className={styles.primary} aria-disabled={!canWatch || undefined} onClick={() => canWatch && void start()}>
            Watch live
          </button>
        </>
      )}
    </section>
  );
}
