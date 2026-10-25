"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PRESET_ORDER, PRESET_REPLIES, PhoneApiError, type PhoneApi, type PhoneMember, type PresetReplyId } from "@/lib/phoneApi";
import {
  alertsSentence,
  caregiverOf,
  helpTileLine,
  incoming,
  newCountLine,
  newId,
  sendError,
  spokenMessage,
  statusSentence,
  unseen,
} from "@/lib/phoneView";
import { CameraSharing, CameraWatchingLine } from "./CameraCard";
import { HelpBanner, HelpIcon, RoseHelp } from "./HelpScreens";
import { NearbySample } from "./NearbySample";
import styles from "./Phone.module.css";
import chat from "./RoseMessages.module.css";

export type RoseScreen = "home" | "help" | "walker" | "messages" | "nearby";

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
 * Her own phone, in simple mode: four huge tiles, one action each, no typing. Get help comes first. Nothing
 * here changes the walker; only the walker's own Confirm does that.
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
      {api.camera ? <CameraWatchingLine camera={api.camera} /> : null}
      {screen === "home" ? (
        <>
          {home.help ? <HelpBanner help={home.help} /> : null}
          <div className={styles.screen}>
            <h1 id={HEADING} tabIndex={-1} className={styles.title}>
              Hello, {home.me.name}
            </h1>
          </div>
          <ul className={styles.tiles}>
            <li>
              <button type="button" className={`${styles.tile} ${styles.helpTile}`} onClick={() => go("help")}>
                <HelpIcon />
                <span className={styles.tileText}>
                  <span className={styles.tileLabel}>Get help</span>
                  <span className={styles.tileSub}>{helpTileLine(home)}</span>
                </span>
              </button>
            </li>
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
      {screen === "help" ? <RoseHelp home={home} api={api} refresh={refresh} announce={announce} headingId={HEADING} /> : null}
      {screen === "walker" ? <MyWalker home={home} api={api} refresh={refresh} announce={announce} /> : null}
      {screen === "messages" ? <Messages home={home} api={api} refresh={refresh} announce={announce} /> : null}
      {screen === "nearby" ? <NearbySample role="walker_user" heading="People nearby" headingId={HEADING} /> : null}
    </div>
  );
}

function MyWalker({ home, api, refresh, announce }: { home: PhoneMember; api: PhoneApi; refresh(): Promise<void>; announce(text: string): void }) {
  const w = home.walker;
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function changeSharing() {
    if (changing) return;
    const enabled = !w.location_sharing_enabled;
    setChanging(true);
    setError(null);
    try {
      await api.setLocationSharing(enabled);
      await refresh();
      announce(enabled ? "Location sharing is on." : "Location sharing is off. The saved position was erased.");
    } catch {
      setError("Couldn't change location sharing. Try again.");
    } finally {
      setChanging(false);
    }
  }
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
      <section className={styles.card} aria-labelledby="location-sharing-title">
        <h2 id="location-sharing-title" className={styles.cardTitle}>Location sharing</h2>
        <p>Only approved caretakers can see your walker's latest GPS position. Sharing starts off. You can turn it off at any time; that erases the saved position.</p>
        <p>{w.location_sharing_enabled ? "Sharing is on." : "Sharing is off."}</p>
        <button type="button" className={styles.primary} aria-pressed={w.location_sharing_enabled === true} disabled={changing} onClick={() => void changeSharing()}>
          {changing ? "Changing…" : w.location_sharing_enabled ? "Stop sharing my location" : "Share my location with approved caretakers"}
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </section>
      {api.camera ? <CameraSharing camera={api.camera} announce={announce} /> : null}
      {w.simulator ? <p className={styles.bigNote}>This walker is the simulator, running on a computer.</p> : null}
      <p className={styles.bigNote}>To change your alerts, ask Sophi on the walker.</p>
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

  const fromMaya = incoming(home.messages).length > 0;
  // The thread as the server sends it, oldest first, so the newest sits last, just above her replies.
  const thread = home.messages;

  // On open, scroll so her replies' end is in view with the newest message just above them, and never past
  // that message's top. Instant (no smooth scroll), so nothing moves under reduced motion. A passive effect,
  // so it runs after RosePhone's layout effect moves focus to the heading. Again once the page knows the
  // phone can speak, since "Tap to hear it" makes her messages taller (that happens once, right after open).
  const last = useRef<HTMLLIElement>(null);
  const end = useRef<HTMLElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
    const top = last.current?.getBoundingClientRect().top;
    if (top !== undefined && top < 0) last.current?.scrollIntoView({ block: "start" });
  }, [canSpeak]);

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
      {maya && !fromMaya ? <p className={styles.bigBody}>No messages from {maya.name} yet.</p> : null}
      {maya && fromMaya ? (
        // The walker reads each new message a caretaker sends her aloud (docs/interfaces.md, "Her incoming
        // messages, read aloud"), but not ones already there when it starts, so this says "new".
        <p className={chat.note}>
          <SpeakerIcon />
          Your walker reads {maya.name}&apos;s new messages aloud.
        </p>
      ) : null}
      {thread.length > 0 ? (
        <ol className={chat.thread} aria-label="Messages, newest last">
          {thread.map((m, i) => {
            // Who said it, in words, for a screen reader: "Maya said: Lunch is in the fridge. Tap to hear it".
            // The spaces between the parts are for that name; the grid layout doesn't draw them.
            const words = (
              <>
                <span className={chat.who}>
                  {m.mine ? "You" : m.from_name}
                  <span className="visually-hidden"> said:</span>
                </span>{" "}
                <span className={chat.text}>{m.text}</span>
              </>
            );
            return (
              <li key={m.message_id} ref={i === thread.length - 1 ? last : undefined} className={chat.item} data-mine={m.mine || undefined}>
                {/* Before the page knows the phone can speak, her message is text, not a button that does nothing. */}
                {!m.mine && canSpeak ? (
                  <button type="button" className={chat.bubble} onClick={() => hear(spokenMessage(m))}>
                    {words}{" "}
                    <span className={chat.hear}>
                      <SpeakerIcon />
                      Tap to hear it
                    </span>
                  </button>
                ) : (
                  <div className={chat.bubble}>{words}</div>
                )}
              </li>
            );
          })}
        </ol>
      ) : null}
      {maya ? (
        <section ref={end} className={chat.replies} aria-labelledby="reply-heading">
          <h2 id="reply-heading" className={chat.repliesTitle}>
            Reply to {maya.name}
          </h2>
          <ul className={chat.replyList}>
            {PRESET_ORDER.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  className={chat.reply}
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
