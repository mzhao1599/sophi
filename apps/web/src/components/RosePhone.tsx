"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PRESET_ORDER, PRESET_REPLIES, PhoneApiError, type PhoneApi, type PhoneMember, type PresetReplyId } from "@/lib/phoneApi";
import {
  alertsSentence,
  caregiverOf,
  incoming,
  newCountLine,
  newId,
  sendError,
  spokenMessage,
  statusSentence,
  unseen,
} from "@/lib/phoneView";
import { NearbySample } from "./NearbySample";
import styles from "./Phone.module.css";

export type RoseScreen = "home" | "walker" | "messages" | "nearby";

const HEADING = "rose-heading";
const SEEN_KEY = "sophi-app-seen";

function loadSeen(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-40)));
  } catch {
    // Private mode or blocked storage: "new" just resets on reload.
  }
}

/**
 * Her own phone, in simple mode: at most four huge tiles, one action each, no typing. Nothing here changes
 * the walker; only the walker's own Confirm does that.
 */
export function RosePhone({
  home,
  api,
  refresh,
  announce,
  initialScreen = "home",
}: {
  home: PhoneMember;
  api: PhoneApi;
  refresh(): Promise<void>;
  announce(text: string): void;
  initialScreen?: RoseScreen;
}) {
  const [screen, setScreen] = useState<RoseScreen>(initialScreen);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  useEffect(() => setSeen(loadSeen()), []);
  const maya = caregiverOf(home);
  const fresh = unseen(home.messages, seen);

  // Opening Messages shows everything that came in.
  useEffect(() => {
    if (screen !== "messages") return;
    const ids = incoming(home.messages).map((m) => m.message_id);
    if (ids.every((i) => seen.has(i))) return;
    const next = new Set([...seen, ...ids]);
    setSeen(next);
    saveSeen(next);
  }, [screen, home.messages, seen]);

  // A new screen takes focus to its heading, after her tap (never on load).
  // Compared with the last screen, not a "first run" flag: development's Strict Mode runs effects twice.
  const shown = useRef(screen);
  useLayoutEffect(() => {
    if (shown.current === screen) return;
    shown.current = screen;
    document.getElementById(HEADING)?.focus();
  }, [screen]);

  const go = (s: RoseScreen) => setScreen(s);

  return (
    <div className={`${styles.screen} ${styles.fade}`} key={screen}>
      {screen === "home" ? (
        <>
          <div className={styles.screen}>
            <h1 id={HEADING} tabIndex={-1} className={styles.title}>
              Hello, {home.me.name}
            </h1>
          </div>
          <ul className={styles.tiles}>
            <li>
              <button type="button" className={styles.tile} onClick={() => go("walker")}>
                <WalkerIcon />
                <span className={styles.tileText}>
                  <span className={styles.tileLabel}>My walker</span>
                  <span className={styles.tileSub}>{home.walker.online ? "On" : "Not connected"}</span>
                </span>
              </button>
            </li>
            <li>
              <button type="button" className={styles.tile} onClick={() => go("messages")}>
                <MessageIcon />
                <span className={styles.tileText}>
                  <span className={styles.tileLabel}>{maya ? `Message ${maya.name}` : "Messages"}</span>
                  {newCountLine(fresh.length) ? (
                    <span className={styles.tileSub}>
                      <strong>{newCountLine(fresh.length)}</strong>
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
            <li>
              <button type="button" className={styles.tile} onClick={() => go("nearby")}>
                <PeopleIcon />
                <span className={styles.tileText}>
                  <span className={styles.tileLabel}>People nearby</span>
                  <span className={styles.tileSub}>
                    <span className={styles.tag}>Sample</span>
                  </span>
                </span>
              </button>
            </li>
          </ul>
        </>
      ) : (
        <button type="button" className={styles.back} onClick={() => go("home")}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 5l-7 7 7 7" />
          </svg>
          Back
        </button>
      )}
      {screen === "walker" ? <MyWalker home={home} /> : null}
      {screen === "messages" ? <Messages home={home} api={api} refresh={refresh} announce={announce} /> : null}
      {screen === "nearby" ? <NearbySample role="walker_user" heading="People nearby" headingId={HEADING} /> : null}
    </div>
  );
}

function MyWalker({ home }: { home: PhoneMember }) {
  const w = home.walker;
  return (
    <section className={styles.screen} aria-labelledby={HEADING}>
      <div className={styles.titleRow}>
        <h1 id={HEADING} tabIndex={-1} className={styles.title}>
          My walker
        </h1>
        {w.simulator ? <span className={styles.tag}>Simulator</span> : null}
      </div>
      <p className={styles.presence}>
        <span className={styles.dot} data-online={w.online} aria-hidden="true" />
        <span className={styles.big}>{statusSentence(w)}</span>
      </p>
      <p className={styles.bigBody}>{alertsSentence(w.alerts)}</p>
      {w.simulator ? <p className={styles.bigNote}>This walker is the simulator, running on a computer.</p> : null}
      <p className={styles.bigNote}>Nothing on this phone changes your walker. To change your alerts, ask Sophi on the walker.</p>
    </section>
  );
}

type SendState = { preset: PresetReplyId; status: "sending" | "sent" | "failed"; line: string } | null;

function Messages({ home, api, refresh, announce }: { home: PhoneMember; api: PhoneApi; refresh(): Promise<void>; announce(text: string): void }) {
  const maya = caregiverOf(home);
  const [canSpeak, setCanSpeak] = useState(false);
  useEffect(() => setCanSpeak(typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined"), []);
  const [send, setSend] = useState<SendState>(null);
  // A retry after a failure reuses the same id, so the server never stores a reply twice.
  const retryIds = useRef<Partial<Record<PresetReplyId, string>>>({});

  const newest = incoming(home.messages)[0];
  const earlier = [...home.messages].reverse().filter((m) => m.message_id !== newest?.message_id);

  function hear(text: string) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch {
      // The words are on screen whatever happens.
    }
  }

  async function reply(preset: PresetReplyId) {
    if (!maya || send?.status === "sending") return;
    const clientId = retryIds.current[preset] ?? newId();
    retryIds.current[preset] = clientId;
    setSend({ preset, status: "sending", line: "Sending" });
    try {
      await api.sendPreset(clientId, preset, maya.member_id);
      delete retryIds.current[preset];
      const line = `Sent to ${maya.name}: ${PRESET_REPLIES[preset]}`;
      setSend({ preset, status: "sent", line });
      announce(line);
      void refresh();
    } catch (e) {
      const line = sendError(e instanceof PhoneApiError ? e.code : "network");
      setSend({ preset, status: "failed", line });
      announce(line);
    }
  }

  return (
    <section className={styles.screen} aria-labelledby={HEADING}>
      <h1 id={HEADING} tabIndex={-1} className={styles.title}>
        {maya ? `Messages with ${maya.name}` : "Messages"}
      </h1>
      {!maya ? <p className={styles.bigBody}>No one is linked to message yet.</p> : null}
      {maya && !newest ? <p className={styles.bigBody}>No messages from {maya.name} yet.</p> : null}
      {newest ? (
        canSpeak ? (
          <button type="button" className={styles.message} onClick={() => hear(spokenMessage(newest))}>
            <span className={styles.messageFrom}>{newest.from_name}</span>
            <span className={styles.messageText}>{newest.text}</span>
            <span className={styles.hear}>
              <SpeakerIcon />
              Tap to hear it
            </span>
          </button>
        ) : (
          <div className={styles.message}>
            <span className={styles.messageFrom}>{newest.from_name}</span>
            <span className={styles.messageText}>{newest.text}</span>
          </div>
        )
      ) : null}
      {maya ? (
        <section className={styles.screen} aria-labelledby="reply-heading">
          <h2 id="reply-heading" className={styles.h2}>
            Reply to {maya.name}
          </h2>
          <ul className={styles.replies}>
            {PRESET_ORDER.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  className={styles.reply}
                  aria-disabled={send?.status === "sending" || undefined}
                  onClick={() => void reply(p)}
                >
                  {PRESET_REPLIES[p]}
                </button>
              </li>
            ))}
          </ul>
          {send && send.status !== "sending" ? (
            <p className={send.status === "failed" ? styles.alert : styles.lasting}>{send.line}</p>
          ) : null}
        </section>
      ) : null}
      {earlier.length > 0 ? (
        <section className={styles.screen} aria-labelledby="earlier-heading">
          <h2 id="earlier-heading" className={styles.h2}>
            Earlier
          </h2>
          <ul className={styles.earlier}>
            {earlier.map((m) => (
              <li key={m.message_id}>
                <span className={styles.who}>{m.mine ? "You" : m.from_name}:</span> {m.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function WalkerIcon() {
  return (
    <svg className={styles.tileIcon} viewBox="0 0 44 44" aria-hidden="true" focusable="false">
      <path d="M14 8h14l4 28M14 8l-4 28M12 20h18" />
      <circle cx="10" cy="37" r="3" />
      <circle cx="32" cy="37" r="3" />
    </svg>
  );
}

function MessageIcon() {
  return (
    <svg className={styles.tileIcon} viewBox="0 0 44 44" aria-hidden="true" focusable="false">
      <path d="M7 10h30v20H18l-8 7v-7H7z" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg className={styles.tileIcon} viewBox="0 0 44 44" aria-hidden="true" focusable="false">
      <circle cx="15" cy="15" r="5" />
      <circle cx="30" cy="15" r="5" />
      <path d="M5 35c1-7 5-10 10-10s9 3 10 10M21 29c2-3 5-4 9-4 5 0 9 3 10 10" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11" />
    </svg>
  );
}
