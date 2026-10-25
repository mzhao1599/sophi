"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WalkerModel, WalkerStatusView } from "@walker/contracts";
import { PRODUCT_NAME } from "@/lib/brand";
import { useNow } from "@/lib/useNow";
import { useWalkerPage, type WalkerPage } from "@/lib/useWalkerPage";
import { createOwnerPhonesApi, type OwnerPhonesApi } from "@/lib/phoneApi";
import { createDemoCircle } from "@/lib/phoneFake";
import { createWalkerApi, type WalkerPageApi } from "@/lib/walkerApi";
import { createFakeWalker, type FakeWalkerControls } from "@/lib/walkerFake";
import {
  APPLIED_WORD,
  NOT_LIVE_AFTER_MS,
  appliedState,
  cueWord,
  drawingCaption,
  formatCode,
  formatCountdown,
  pairCommand,
  partRows,
  presence,
  relativeAgo,
  secondsLeft,
  zoneRows,
} from "@/lib/walkerView";
import { BehindTheScenes } from "./BehindTheScenes";
import { ContourField } from "./ContourField";
import { FakeControls } from "./FakeWalkerControls";
import { LiveWalkerDiagram } from "./LiveWalkerDiagram";
import { PhonesPanel } from "./PhonesPanel";
import { WalkerConversation } from "./WalkerConversation";
import { WalkerMark } from "./WalkerMark";
import demo from "./Demo.module.css";
import styles from "./Walker.module.css";

const HEADING_ID = "walker-heading";

/**
 * "Your walker": the owner's live view of a paired walker, separate from the onboarding demo on `/`.
 * With `fake` (development only, `/walker?fake=1`), a typed fake of the page API stands in for the
 * server, and a banner says so on every screen. `typedBy` is who reads typed words on this server, for
 * the notice above the text box.
 */
export function WalkerScreen({ fake = false, typedBy = null }: { fake?: boolean; typedBy?: WalkerModel | null }) {
  const [{ api, controls }] = useState<{ api: WalkerPageApi; controls: FakeWalkerControls | null }>(() =>
    fake ? createFakeWalker() : { api: createWalkerApi(), controls: null },
  );
  const page = useWalkerPage(api);
  // The phones linked to the walker: the fake's own circle under the "Fake walker" banner, else the server.
  const [phones] = useState<OwnerPhonesApi>(() => (fake ? createDemoCircle().owner() : createOwnerPhonesApi()));
  // Which walker the Forget dialog was opened for: it never opens for another one.
  const [forgetFor, setForgetFor] = useState<string | null>(null);
  useEffect(() => setForgetFor(null), [page.walker?.device_id]);
  // "Connect another walker" while one is paired; a new walker arriving (or one going) ends it.
  const [adding, setAdding] = useState(false);
  const count = page.walkers.length;
  useEffect(() => setAdding(false), [count]);
  const walker = page.walker;
  // A view change takes the focused control away (the code panel on pairing, the page on a 401, the
  // last walker going): focus goes to the new view's heading. Not on the first load.
  const view = `${page.phase}/${adding}/${walker?.device_id ?? ""}`;
  const lastView = useRef(view);
  useLayoutEffect(() => {
    const before = lastView.current;
    lastView.current = view;
    if (before === view || before.startsWith("loading/")) return;
    const active = document.activeElement;
    if (!active || active === document.body) document.getElementById(HEADING_ID)?.focus();
  }, [view]);

  return (
    <>
      <ContourField />
      {controls ? (
        <p className={styles.fakeBanner} role="note">
          Fake walker: development only. Nothing here is live, and the replies are canned, not a model&apos;s.
        </p>
      ) : null}
      <header className={`${demo.bar} ${styles.bar}`}>
        <span className={demo.brand}>
          <WalkerMark size={24} />
          <span className={demo.wordmark}>{PRODUCT_NAME}</span>
          <span className={demo.line}>Your walker</span>
        </span>
        <div className={demo.barRight}>
          {walker && !adding ? (
            <button type="button" className={demo.barButton} onClick={() => setAdding(true)}>
              Connect another walker
            </button>
          ) : null}
          {walker ? (
            <button
              type="button"
              className={demo.barButton}
              onClick={() => {
                page.resetForget();
                setForgetFor(walker.device_id);
              }}
            >
              Forget this walker
            </button>
          ) : null}
        </div>
      </header>

      <main id="main" className={styles.main}>
        <p className="visually-hidden" role="status" aria-live="polite">
          {page.announcement.text}
          {page.announcement.n % 2 ? "​" : ""}
        </p>
        {page.phase === "loading" ? <Loading page={page} /> : null}
        {page.phase === "none" || (adding && walker) ? <Connect page={page} back={adding && walker ? { name: walker.name, go: () => setAdding(false) } : null} /> : null}
        {page.phase === "paired" && walker && !adding ? <Paired page={page} walker={walker} phones={phones} typedBy={typedBy} /> : null}
      </main>

      {walker ? (
        <ForgetDialog key={walker.device_id} page={page} walker={walker} open={forgetFor === walker.device_id} onClose={() => setForgetFor(null)} />
      ) : null}
      {controls ? <FakeControls controls={controls} onChange={page.pollNow} /> : null}
    </>
  );
}

function Loading({ page }: { page: WalkerPage }) {
  return (
    <>
      <section className={styles.talk} aria-labelledby={HEADING_ID}>
        <div className={styles.pairPanel}>
          <h1 id={HEADING_ID} className={styles.title}>
            Loading your walker
          </h1>
          {page.pollFailure ? (
            <p className={styles.stale} role="alert">
              {page.pollFailure === "network" ? "Can't reach Sophi's server. Check the connection; this page keeps trying." : "Sophi's server isn't available right now. This page keeps trying."}
            </p>
          ) : null}
        </div>
      </section>
      <div className={styles.walker} data-bare="">
        <LiveWalkerDiagram rows={[]} caption="The walker's frame." />
      </div>
    </>
  );
}

/** No walker yet: get a code, show it large with its countdown and the command to run on the walker. */
function Connect({ page, back = null }: { page: WalkerPage; back?: { name: string; go(): void } | null }) {
  const now = useNow(500);
  const [origin, setOrigin] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);
  const pairing = page.pairing;
  const left = pairing ? secondsLeft(pairing.expiresAtMs, now + (page.serverNow() - Date.now())) : 0;
  const live = pairing && left > 0;
  // The pressed button gives way to the code: focus follows it there, and back to the button when it expires.
  const codeRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasLive = useRef(Boolean(live));
  useLayoutEffect(() => {
    if (wasLive.current === Boolean(live)) return;
    wasLive.current = Boolean(live);
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (live ? codeRef.current : buttonRef.current)?.focus({ preventScroll: true });
  }, [live]);

  async function copy(command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <section className={styles.talk} aria-labelledby={HEADING_ID}>
        <div className={styles.pairPanel}>
          <h1 id={HEADING_ID} tabIndex={-1} className={styles.title}>
            {back ? "Connect another walker" : "Connect a walker"}
          </h1>
          <p className={styles.lead}>
            Pairing links a walker to this browser, so this page shows what the walker reports and what it hears and says.
          </p>
          {page.notice ? <p className={styles.lasting}>{page.notice}</p> : null}
          {live ? (
            <>
              <div
                ref={codeRef}
                tabIndex={-1}
                role="group"
                aria-label={`Pairing code ${pairing.code.split("").join(" ")}`}
                className={styles.codeBlock}
              >
                <p className={styles.codeLabel}>Pairing code</p>
                <p className={styles.code}>
                  <span aria-hidden="true">{formatCode(pairing.code)}</span>
                  <span className="visually-hidden">{pairing.code.split("").join(" ")}</span>
                </p>
                <p className={styles.meta} role="timer">
                  Expires in {formatCountdown(left)}
                </p>
              </div>
              <div>
                <p className={styles.codeLabel}>On the walker, run:</p>
                <div className={styles.command}>
                  <code>{pairCommand(pairing.code, origin)}</code>
                  <button type="button" className="button button-secondary" onClick={() => void copy(pairCommand(pairing.code, origin))}>
                    {copied ? "Copied" : "Copy"}
                    <span className="visually-hidden"> the command</span>
                  </button>
                </div>
              </div>
              <p className={styles.meta}>This page switches to your walker as soon as it&apos;s paired.</p>
            </>
          ) : (
            <>
              {pairing ? <p className={styles.lasting}>That code expired.</p> : null}
              <button
                ref={buttonRef}
                type="button"
                className={`button button-primary ${styles.primary}`}
                aria-disabled={page.pairingBusy || undefined}
                onClick={() => void page.getCode()}
              >
                {page.pairingBusy ? "Getting a code" : pairing ? "Get a new code" : "Get a pairing code"}
              </button>
            </>
          )}
          {page.pairingError ? (
            <p className={styles.alertLine} role="alert">
              {page.pairingError}
            </p>
          ) : null}
          {page.pollFailure && page.pollFailure !== "unauthenticated" ? <NotLive page={page} /> : null}
          {back ? (
            <button type="button" className="button-text" onClick={back.go}>
              Back to {back.name}
            </button>
          ) : null}
        </div>
      </section>
      <div className={styles.walker} data-bare="">
        <LiveWalkerDiagram rows={[]} caption="The walker's frame. Its parts appear once it's paired." />
        <p className={styles.stageNote}>Once it&apos;s paired, each part the walker reports appears here, with its health.</p>
      </div>
    </>
  );
}

function NotLive({ page }: { page: WalkerPage }) {
  const now = useNow(1000);
  if (page.lastOkAtMs && now - page.lastOkAtMs <= NOT_LIVE_AFTER_MS) return null;
  const ago = page.lastOkAtMs ? ` Showing what it said ${relativeAgo(now - page.lastOkAtMs)}.` : "";
  return <p className={styles.stale}>Can&apos;t reach Sophi&apos;s server.{ago}</p>;
}

function Paired({ page, walker, phones, typedBy }: { page: WalkerPage; walker: WalkerStatusView; phones: OwnerPhonesApi; typedBy: WalkerModel | null }) {
  const rows = useMemo(() => partRows(walker.parts), [walker.parts]);
  const caption = useMemo(() => drawingCaption(rows), [rows]);
  const now = useNow(1000);
  const live = now - page.lastOkAtMs <= NOT_LIVE_AFTER_MS;
  return (
    <>
      <div className={styles.head}>
        <p className={styles.kicker}>Your walker</p>
        <div className={styles.titleRow}>
          <h1 id={HEADING_ID} tabIndex={-1} className={styles.title}>
            {walker.name}
          </h1>
          {walker.simulator ? <span className={styles.badge}>Simulator</span> : null}
        </div>
        <Presence page={page} walker={walker} />
        {walker.simulator ? <p className={styles.meta}>This walker is the simulator running on a computer, not a Pi.</p> : null}
        {page.walkers.length > 1 ? (
          <label className={styles.picker}>
            Walker
            <select value={walker.device_id} onChange={(e) => page.select(e.target.value)}>
              {page.walkers.map((w) => (
                <option key={w.device_id} value={w.device_id}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {page.notice ? <p className={styles.lasting}>{page.notice}</p> : null}
        <NotLive page={page} />
      </div>

      <div className={styles.talk}>
        <WalkerConversation page={page} walker={walker} typedBy={typedBy} />
      </div>

      <BehindTheScenes page={page} walker={walker} />

      {/* Dimmed while Sophi's server can't be reached, so old readings don't look current. */}
      <section className={styles.walker} data-stale={live ? undefined : ""} aria-label="What the walker reports">
        <LiveWalkerDiagram rows={rows} caption={caption} />
        <div className={styles.cards}>
          <Alerts walker={walker} />
          <Obstacles page={page} walker={walker} />
          <section className={`${styles.card} ${styles.partsCard}`} aria-labelledby="parts-heading">
            <h2 id="parts-heading" className={styles.cardTitle}>
              Parts
            </h2>
            {rows.length === 0 ? (
              <p className={styles.empty}>No parts reported yet.</p>
            ) : (
              <ul className={styles.rows}>
                {rows.map((r) => (
                  <li key={r.key} className={styles.row}>
                    <span className={styles.rowTop}>
                      <span className={styles.rowName}>{r.name}</span>
                      {r.simulated ? <span className={styles.tag}>Simulated</span> : null}
                    </span>
                    <span className={styles.rowWords}>
                      {[r.healthWord, r.inConfiguration ? null : "Not in your setup"].filter(Boolean).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <PhonesPanel key={walker.device_id} api={phones} deviceId={walker.device_id} />
        </div>
      </section>
    </>
  );
}

function Presence({ page, walker }: { page: WalkerPage; walker: WalkerStatusView }) {
  const now = useNow(1000);
  const live = now - page.lastOkAtMs <= NOT_LIVE_AFTER_MS;
  const p = presence(walker, now + (page.serverNow() - Date.now()), live);
  return (
    <p className={styles.presence}>
      <span className={styles.presenceWord}>
        <span className={styles.presenceDot} data-tone={p.tone} aria-hidden="true" />
        {p.word}
      </span>
      {p.detail ? <span className={styles.presenceDetail}>{p.detail}</span> : null}
    </p>
  );
}

function Alerts({ walker }: { walker: WalkerStatusView }) {
  const state = appliedState(walker);
  return (
    <section className={styles.card} aria-labelledby="alerts-heading">
      <div className={styles.cardHead}>
        <h2 id="alerts-heading" className={styles.cardTitle}>
          Alerts
        </h2>
        <span className={styles.meta}>Version {walker.configuration.version}</span>
      </div>
      <ul className={styles.cueList}>
        {walker.configuration.cues.map((cue) => (
          <li key={cue}>{cueWord(cue)}</li>
        ))}
      </ul>
      <p className={styles.applied} data-state={state}>
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          {state === "applied" ? <path d="M5 10.4l3.2 3.1L15 6.6" /> : <circle cx="10" cy="10" r="7" />}
        </svg>
        {APPLIED_WORD[state]}
      </p>
    </section>
  );
}

function Obstacles({ page, walker }: { page: WalkerPage; walker: WalkerStatusView }) {
  const now = useNow(250);
  const live = now - page.lastOkAtMs <= NOT_LIVE_AFTER_MS;
  const rows = zoneRows(walker.zones, now - page.receivedAtMs, live);
  return (
    <section className={styles.card} aria-labelledby="zones-heading">
      <h2 id="zones-heading" className={styles.cardTitle}>
        Obstacles
      </h2>
      {rows.length === 0 ? (
        <p className={styles.empty}>No obstacle sensors reporting.</p>
      ) : (
        <ul className={styles.zones}>
          {rows.map((z) => (
            <li key={z.key} className={styles.zone}>
              <span className={styles.rowTop}>
                <span className={styles.rowName}>{z.name}</span>
                {z.simulated ? <span className={styles.tag}>Simulated</span> : null}
              </span>
              <span className={styles.distance} data-measured={z.measured}>
                {z.value}
              </span>
              <span className={styles.rowDetail}>{z.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "Forget this walker", behind a modal confirm. Keep it is focused first; Escape closes it. */
function ForgetDialog({ page, walker, open, onClose }: { page: WalkerPage; walker: WalkerStatusView; open: boolean; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  async function forget() {
    if (page.forgetting) return;
    if (await page.forget()) {
      onClose();
      requestAnimationFrame(() => document.getElementById(HEADING_ID)?.focus());
    }
  }

  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby="forget-title" aria-describedby="forget-text" onClose={onClose}>
      <h2 id="forget-title">Forget {walker.name}?</h2>
      <p id="forget-text">
        This deletes its conversation, settings and offers from the server now. The walker stops working with this page until it&apos;s paired
        again.
      </p>
      {page.forgetError ? (
        <p className={styles.alertLine} role="alert">
          {page.forgetError}
        </p>
      ) : null}
      <div className={styles.dialogActions}>
        <button type="button" className="button button-secondary" autoFocus onClick={onClose}>
          Keep it
        </button>
        <button type="button" className={`button ${styles.danger}`} aria-disabled={page.forgetting || undefined} onClick={() => void forget()}>
          {page.forgetting ? "Forgetting" : "Forget"}
        </button>
      </div>
    </dialog>
  );
}
