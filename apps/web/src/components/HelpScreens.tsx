"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { PhoneApiError, type HelpView, type PhoneApi, type PhoneMember } from "@/lib/phoneApi";
import {
  NO_CARETAKER,
  askedHowLine,
  agoWords,
  caretakerNames,
  closedForLine,
  comingForLine,
  helpNames,
  goesToLine,
  helpSendError,
  herClosedLine,
  herLocationLine,
  herName,
  herOpenLine,
  newId,
  sentLine,
  sentOthersLine,
  shownLine,
  walkerUserOf,
} from "@/lib/phoneView";
import { NearbyMap, type MapPin } from "./NearbyMap";
import styles from "./Phone.module.css";

/**
 * Asking for help on the two phones (docs/subsystems/help.md, "The phones"; expected results in
 * test/help-phones.EXPECTED.md). Everything shown comes from the server's `help` on the phone's home, or from the
 * answer to this phone's own tap while the next home is on its way. Changes are announced once by the app's live
 * region (PhoneApp), not here. Focus moves only after this phone's own tap, or back to the heading when the
 * control that had it went away.
 */

const failure = (e: unknown) => (e instanceof PhoneApiError ? e.code : "network");

/** The Call 911 link: the phone's own dialer asks before calling. Sophi never calls anyone. */
function Call911({ big }: { big?: boolean }) {
  return (
    <a href="tel:911" className={`${styles.secondary} ${styles.call} ${big ? styles.callBig : ""}`}>
      <PhoneIcon />
      Call 911
    </a>
  );
}

/** A raised hand in a ring: the help mark, a shape of its own beside the word. */
export function HelpIcon({ className = styles.tileIcon }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 44 44" aria-hidden="true" focusable="false">
      <circle cx="22" cy="22" r="19" />
      <path d="M16 25v-9a2 2 0 014 0v6M20 22v-9a2 2 0 014 0v9M24 22v-7a2 2 0 014 0v10c0 5-3 8-7 8s-6-2-8-5l-3-5a2 2 0 013-2l3 3" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 3h3l2 5-2 1.5a11 11 0 005.5 5.5L16 13l5 2v3a2 2 0 01-2 2A16 16 0 014 5a2 2 0 012-2z" />
    </svg>
  );
}

/**
 * Keeps keyboard and screen-reader focus from being lost when the control that had it goes away (the request
 * closed or opened under it): focus then goes to `heading`, which stays. Nothing moves while focus is elsewhere.
 */
function useKeepFocus(view: string, box: React.RefObject<HTMLElement | null>, heading: React.RefObject<HTMLElement | null>) {
  const last = useRef(view);
  const had = useRef(false);
  // Remember, before each render's DOM change, whether focus was inside the box.
  had.current = typeof document !== "undefined" && !!box.current && box.current.contains(document.activeElement);
  useLayoutEffect(() => {
    if (last.current === view) return;
    last.current = view;
    if (had.current && (document.activeElement === document.body || document.activeElement === null)) heading.current?.focus();
  }, [view, heading]);
}

// ---- Her phone ----

/** The banner that leads her home while a request is open, or says how it closed (the server sends it 5 minutes). */
export function HelpBanner({ help }: { help: HelpView }) {
  return (
    <div className={styles.helpBanner} data-open={!help.closed}>
      <HelpIcon className={styles.helpMark} />
      {help.closed ? (
        <p className={styles.bigBody}>{herClosedLine(help)}</p>
      ) : (
        <p className={styles.bigBody}>
          <strong>You asked for help.</strong> {herOpenLine(help)}
        </p>
      )}
    </div>
  );
}

/** Her Get help screen: ask (two taps on purpose), then the open status with "I'm okay now". */
export function RoseHelp({ home, api, refresh, announce, headingId }: { home: PhoneMember; api: PhoneApi; refresh(): Promise<void>; announce(text: string): void; headingId: string }) {
  const names = caretakerNames(home);
  const [busy, setBusy] = useState<"asking" | "okay" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The answer to her own tap, shown until the home that follows it arrives.
  const [answer, setAnswer] = useState<HelpView | null>(null);
  // One id per ask until it succeeds, so a retry never makes a second request.
  const clientId = useRef<string | null>(null);
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const question = useRef<HTMLHeadingElement>(null);
  const okayButton = useRef<HTMLButtonElement>(null);
  const askButton = useRef<HTMLButtonElement>(null);

  const help = answer ?? home.help;
  const open = help && !help.closed ? help : null;
  const view = open ? (confirming ? "confirm" : "open") : "ask";
  useKeepFocus(view, box, heading);

  // Her own taps move focus: to the question, back to "I'm okay now", or to the heading of what the screen became.
  const focusNext = useRef<"question" | "okay" | "heading" | null>(null);
  useLayoutEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    ({ question, okay: okayButton, heading })[target].current?.focus();
  }, [view]);

  async function act(kind: "asking" | "okay", call: () => Promise<HelpView>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      const h = await call();
      if (kind === "asking") clientId.current = null;
      setAnswer(h);
      focusNext.current = "heading";
      setConfirming(false);
      await refresh();
    } catch (e) {
      const code = failure(e);
      if (code === "help_closed" && e instanceof PhoneApiError && e.help) {
        setAnswer(e.help);
        focusNext.current = "heading";
        setConfirming(false);
        await refresh();
      } else {
        const line = helpSendError(code);
        setError(line);
        announce(line);
        if (code === "no_caretaker") await refresh();
      }
    } finally {
      setBusy(null);
      setAnswer(null);
    }
  }

  const ask = () =>
    act("asking", () => {
      clientId.current ??= newId();
      return api.askForHelp(clientId.current);
    });

  const title = open ? "You asked for help" : names.length ? `Ask ${helpNames(names)} for help?` : "Get help";
  return (
    <section ref={box} className={`${styles.screen} ${styles.helpScreen}`} aria-labelledby={headingId}>
      <h1 id={headingId} ref={heading} tabIndex={-1} className={styles.title}>
        {title}
      </h1>
      {open ? (
        <>
          <div className={styles.helpStatus}>
            <p className={styles.big}>{sentLine(open.sent_to)}</p>
            {open.shown_to.length ? <p className={styles.bigBody}>{shownLine(open.shown_to)}</p> : null}
            <p className={styles.bigBody}>{open.coming.length ? herOpenLine(open) : "Nobody has said they're on the way yet."}</p>
            <p className={styles.bigNote}>Asked {agoWords(open.age_seconds)}</p>
          </div>
          {confirming ? (
            <div className={styles.confirm} role="group" aria-labelledby="okay-question">
              <h2 id="okay-question" ref={question} tabIndex={-1} className={styles.h2}>
                Tell {helpNames(open.sent_to.map((p) => p.name))} you&apos;re okay?
              </h2>
              <button type="button" className={styles.reply} aria-disabled={busy !== null || undefined} onClick={() => void act("okay", () => api.helpOkay(open.help_id))}>
                {busy === "okay" ? "Telling them" : "Yes, I'm okay"}
              </button>
              <button
                type="button"
                className={styles.back}
                onClick={() => {
                  if (busy) return;
                  focusNext.current = "okay";
                  setConfirming(false);
                }}
              >
                Not yet
              </button>
            </div>
          ) : (
            <button
              ref={okayButton}
              type="button"
              className={styles.reply}
              onClick={() => {
                focusNext.current = "question";
                setConfirming(true);
              }}
            >
              I&apos;m okay now
            </button>
          )}
        </>
      ) : (
        <>
          {help?.closed ? <p className={`${styles.lasting} ${styles.bigBody}`}>{herClosedLine(help)}</p> : null}
          {names.length ? (
            <>
              <button ref={askButton} type="button" className={styles.askButton} aria-disabled={busy !== null || undefined} onClick={() => void ask()}>
                <HelpIcon className={styles.helpMark} />
                {busy === "asking" ? "Asking" : "Ask for help"}
              </button>
              <p className={styles.bigBody}>{goesToLine(names)}</p>
              <p className={styles.bigNote}>{herLocationLine(home)}</p>
            </>
          ) : (
            <p className={styles.bigBody}>{NO_CARETAKER}</p>
          )}
        </>
      )}
      {error ? <p className={styles.alert}>{error}</p> : null}
      <Call911 big />
    </section>
  );
}

// ---- A caretaker's phone ----

const NO_PINS: readonly MapPin[] = [];

/**
 * The card that leads a caretaker's app while her request is open, and says how it closed for 5 minutes after. Its
 * heading is the page's first, so a screen reader opening the app with a request open lands on it.
 */
export function MayaHelpCard({ home, api, refresh, announce }: { home: PhoneMember; api: PhoneApi; refresh(): Promise<void>; announce(text: string): void }) {
  const [busy, setBusy] = useState<"coming" | "with_her" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<HelpView | null>(null);
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const help = answer ?? home.help;
  const meId = home.me.member_id;
  const coming = !!help && help.coming.some((p) => p.member_id === meId);
  useKeepFocus(help ? `${help.help_id}/${help.closed ? "closed" : coming ? "coming" : "open"}` : "none", box, heading);
  if (!help) return null;

  const her = herName(home);
  const w = home.walker;

  async function act(kind: "coming" | "with_her", call: () => Promise<HelpView>) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      setAnswer(await call());
      await refresh();
    } catch (e) {
      if (e instanceof PhoneApiError && e.code === "help_closed" && e.help) {
        setAnswer(e.help);
        await refresh();
      } else {
        const line = helpSendError(failure(e));
        setError(line);
        announce(line);
      }
    } finally {
      setBusy(null);
      setAnswer(null);
    }
  }

  if (help.closed) {
    return (
      <section ref={box} className={styles.helpCard} data-open="false" aria-labelledby="help-card-title">
        <h1 id="help-card-title" ref={heading} tabIndex={-1} className={styles.helpCardTitle}>
          <HelpIcon className={styles.helpMark} />
          {closedForLine(help, meId, her, !!walkerUserOf(home))}
        </h1>
      </section>
    );
  }

  return (
    <section ref={box} className={styles.helpCard} data-open="true" aria-labelledby="help-card-title">
      <h1 id="help-card-title" ref={heading} tabIndex={-1} className={styles.helpCardTitle}>
        <HelpIcon className={styles.helpMark} />
        {her} asked for help
      </h1>
      <p className={styles.helpLead}>{askedHowLine(help)}</p>
      <p>{sentOthersLine(help, meId)}</p>
      <p className={styles.helpComing}>{comingForLine(help, meId)}</p>
      {w.location ? (
        <figure className={styles.mapFigure}>
          <NearbyMap
            pins={NO_PINS}
            label={`Map of where ${her}'s walker is`}
            center={{ at: [w.location.latitude, w.location.longitude], title: `${her}'s walker`, body: `${her}'s walker, from the GPS fix ${her} chose to share.` }}
          />
          <figcaption className={styles.mapCaption}>
            GPS fix from about {w.location.age_seconds} seconds ago. Map from OpenStreetMap.
          </figcaption>
        </figure>
      ) : (
        <p>{w.location_sharing_enabled ? `No recent GPS fix from ${her}'s walker.` : `${her}'s location isn't shared.`}</p>
      )}
      <div className={styles.helpActions}>
        {coming ? (
          <p className={styles.lasting}>You said you&apos;re on the way.</p>
        ) : (
          <button type="button" className={styles.primary} aria-disabled={busy !== null || undefined} onClick={() => void act("coming", () => api.helpComing(help.help_id))}>
            {busy === "coming" ? "Sending" : "I'm on my way"}
          </button>
        )}
        <button type="button" className={styles.secondary} aria-disabled={busy !== null || undefined} onClick={() => void act("with_her", () => api.helpOkay(help.help_id))}>
          {busy === "with_her" ? "Sending" : `I'm with ${her}`}
        </button>
        <Call911 />
      </div>
      {error ? <p className={styles.alert}>{error}</p> : null}
    </section>
  );
}
