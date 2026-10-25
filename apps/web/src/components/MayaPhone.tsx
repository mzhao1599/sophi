"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { PhoneApiError, type PhoneApi, type PhoneMember } from "@/lib/phoneApi";
import { BATTERY_LINE, counterLine, newCountLine, newId, presenceWord, sendError, unseen, walkerTitle, walkerUserOf } from "@/lib/phoneView";
import { cueWord, partRows } from "@/lib/walkerView";
import { CameraWatch } from "./CameraCard";
import { NearbySample } from "./NearbySample";
import styles from "./Phone.module.css";

export type MayaScreen = "walker" | "messages" | "nearby";

const HEADING = "maya-heading";

/**
 * The caretaker's phone: whether her walker is online, its part health and the alerts in force; messages
 * with her phone; and the sample of people nearby. A recent GPS position appears only while she has opted
 * in on her own phone. There is no "suggest a change" here: the server has no route for one yet.
 */
export function MayaPhone({
  home,
  api,
  refresh,
  announce,
  initialScreen = "walker",
}: {
  home: PhoneMember;
  api: PhoneApi;
  refresh(): Promise<void>;
  announce(text: string): void;
  initialScreen?: MayaScreen;
}) {
  const [screen, setScreen] = useState<MayaScreen>(initialScreen);
  // Messages that came in while another section was open, kept on this phone only.
  const [seen, setSeen] = useState<Set<string>>(() => new Set(home.messages.map((m) => m.message_id)));
  useEffect(() => {
    if (screen === "messages") setSeen((s) => (home.messages.every((m) => s.has(m.message_id)) ? s : new Set([...s, ...home.messages.map((m) => m.message_id)])));
  }, [screen, home.messages]);
  const fresh = newCountLine(unseen(home.messages, seen).length);

  // Compared with the last screen, not a "first run" flag: development's Strict Mode runs effects twice.
  const shown = useRef(screen);
  useLayoutEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    document.getElementById(HEADING)?.focus();
  }, [screen]);

  const tabs: { id: MayaScreen; label: string }[] = [
    { id: "walker", label: "Walker" },
    { id: "messages", label: "Messages" },
    { id: "nearby", label: "Nearby" },
  ];

  return (
    <>
      <nav aria-label="Sections" className={styles.nav}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={styles.navItem}
            aria-current={screen === t.id ? "page" : undefined}
            onClick={() => setScreen(t.id)}
          >
            {t.label}
            {t.id === "messages" && fresh && screen !== "messages" ? <span className={styles.navNew}>, {fresh}</span> : null}
          </button>
        ))}
      </nav>
      <div className={`${styles.screen} ${styles.fade}`} key={screen}>
        {screen === "walker" ? <WalkerStatus home={home} api={api} announce={announce} /> : null}
        {screen === "messages" ? <Thread home={home} api={api} refresh={refresh} announce={announce} /> : null}
        {screen === "nearby" ? <NearbySample role="caregiver" heading="Nearby" headingId={HEADING} /> : null}
      </div>
    </>
  );
}

function WalkerStatus({ home, api, announce }: { home: PhoneMember; api: PhoneApi; announce(text: string): void }) {
  const w = home.walker;
  const rows = partRows(w.parts ?? []);
  return (
    <section className={styles.screen} aria-labelledby={HEADING}>
      <div className={styles.screen} style={{ gap: 8 }}>
        <div className={styles.titleRow}>
          <h1 id={HEADING} tabIndex={-1} className={styles.title}>
            {walkerTitle(home)}
          </h1>
          {w.simulator ? <span className={styles.tag}>Simulator</span> : null}
        </div>
        <p className={styles.presence}>
          <span className={styles.dot} data-online={w.online} aria-hidden="true" />
          {presenceWord(w.online)}
        </p>
        {w.simulator ? <p className={styles.meta}>This walker is the simulator running on a computer, not a Pi.</p> : null}
      </div>
      {api.camera ? <CameraWatch camera={api.camera} herName={walkerUserOf(home)?.name ?? "Her"} announce={announce} /> : null}
      <section className={styles.card} aria-labelledby="alerts-title">
        <h2 id="alerts-title" className={styles.cardTitle}>
          Alerts in force
        </h2>
        <ul className={styles.list}>
          {w.alerts.map((c) => (
            <li key={c}>{cueWord(c)}</li>
          ))}
        </ul>
      </section>
      <section className={styles.card} aria-labelledby="parts-title">
        <h2 id="parts-title" className={styles.cardTitle}>
          Parts
        </h2>
        {rows.length === 0 ? (
          <p>No parts reported yet.</p>
        ) : (
          <ul className={styles.list}>
            {rows.map((r) => (
              <li key={r.key} className={styles.listRow}>
                <span className={styles.rowName}>
                  {r.name}
                  {r.simulated ? <span className={styles.tag}>Simulated</span> : null}
                </span>
                <span>{r.healthWord}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className={styles.card} aria-labelledby="location-title">
        <h2 id="location-title" className={styles.cardTitle}>Walker's location</h2>
        {w.location ? (
          <>
            <p>{w.location.latitude.toFixed(5)}, {w.location.longitude.toFixed(5)}</p>
            <p>GPS fix from about {w.location.age_seconds} seconds ago. Accuracy is not verified.</p>
            <a href={`https://www.openstreetmap.org/?mlat=${w.location.latitude}&mlon=${w.location.longitude}#map=16/${w.location.latitude}/${w.location.longitude}`} target="_blank" rel="noopener noreferrer">Open in OpenStreetMap (shares this position with OpenStreetMap)</a>
          </>
        ) : <p>{w.location_sharing_enabled ? "No recent GPS fix available." : "Location sharing is off."}</p>}
      </section>
      <p className={styles.card}>{BATTERY_LINE}</p>
    </section>
  );
}

function Thread({ home, api, refresh, announce }: { home: PhoneMember; api: PhoneApi; refresh(): Promise<void>; announce(text: string): void }) {
  const rose = walkerUserOf(home);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // The same id until a send succeeds, so a retry is never stored twice.
  const pendingId = useRef<string | null>(null);
  const counter = counterLine(text);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (sending) return;
    if (!text.trim()) {
      setError("Type a message first.");
      return;
    }
    if (counter.over) {
      setError(`Too long: ${counter.line}.`);
      return;
    }
    pendingId.current ??= newId();
    setSending(true);
    setError(null);
    try {
      await api.sendText(pendingId.current, text.trim());
      pendingId.current = null;
      announce(`Sent to ${rose?.name ?? "her phone"}.`);
      setText("");
      void refresh();
    } catch (err) {
      const line = sendError(err instanceof PhoneApiError ? err.code : "network");
      setError(line);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={styles.screen} aria-labelledby={HEADING}>
      <h1 id={HEADING} tabIndex={-1} className={styles.title}>
        {rose ? `Messages with ${rose.name}` : "Messages"}
      </h1>
      {home.messages.length === 0 ? (
        <p className={styles.lead}>No messages yet.</p>
      ) : (
        <ol className={styles.thread} aria-label="Messages, oldest first">
          {home.messages.map((m) => (
            <li key={m.message_id} className={styles.bubble} data-mine={m.mine}>
              <span className={styles.bubbleWho}>{m.mine ? "You" : m.from_name}</span>
              <span>{m.text}</span>
            </li>
          ))}
        </ol>
      )}
      {rose ? (
        <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
          <label className={styles.label} htmlFor="message-text">
            Message to {rose.name}
          </label>
          <div className={styles.sendRow}>
            <input
              id="message-text"
              className={styles.textInput}
              type="text"
              value={text}
              autoComplete="off"
              enterKeyHint="send"
              aria-invalid={counter.over || undefined}
              aria-describedby={error ? "message-counter message-aloud message-error" : "message-counter message-aloud"}
              onChange={(e) => {
                setText(e.target.value);
                if (error) setError(null);
              }}
            />
            <button type="submit" className={styles.primary} aria-disabled={sending || undefined}>
              {sending ? "Sending" : "Send"}
            </button>
          </div>
          <p id="message-counter" className={`${styles.meta} ${styles.counter}`} data-over={counter.over}>
            {counter.line}
          </p>
          <p id="message-aloud" className={styles.meta}>
            {rose.name}&apos;s walker reads your messages aloud.
          </p>
          {error ? (
            <p id="message-error" className={styles.alert} role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className={styles.lead}>Her phone isn&apos;t linked yet, so there&apos;s no one to message.</p>
      )}
    </section>
  );
}
