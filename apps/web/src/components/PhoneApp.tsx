"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { PRODUCT_NAME } from "@/lib/brand";
import { createCameraApi } from "@/lib/cameraApi";
import { buzz, playHelpTone, unlockAudioOnFirstTap } from "@/lib/helpAlert";
import { createPhoneApi, type HelpView, type PhoneApi, type PhoneHome, type PhoneRole } from "@/lib/phoneApi";
import { createPreviewPhone, type DemoCircle, type PreviewOptions } from "@/lib/phoneFake";
import { CANT_REACH, JOIN_NOTICE, codeDigits, helpArrived, helpChange, helpTitle, herName } from "@/lib/phoneView";
import { usePhone, type Phone } from "@/lib/usePhone";
import { MayaPhone } from "./MayaPhone";
import { RosePhone } from "./RosePhone";
import { WalkerMark } from "./WalkerMark";
import styles from "./Phone.module.css";

export const PREVIEW_LINE = "Preview: sample data on this device only. Nothing here is live.";
const HEADING = "app-heading";

/**
 * The two-phone app at /app. On stage both phones use the real server (`createPhoneApi`). `preview`
 * (development only, `/app?preview=rose` or `?preview=maya`) swaps in the in-memory fake with one phone
 * already linked, says "Preview" on every screen, and adds preview controls that drive the fake circle.
 */
/** Screens a link can open on (`/app?screen=`): the same on both phones. Help is never opened by a link. */
export const START_SCREENS = ["walker", "messages", "nearby"] as const;
export type StartScreen = (typeof START_SCREENS)[number];

export function PhoneApp({
  preview = null,
  previewOptions = {},
  start,
}: {
  preview?: PhoneRole | null;
  previewOptions?: PreviewOptions;
  start?: StartScreen;
}) {
  const [api, setApi] = useState<PhoneApi | null>(() => (preview ? null : { ...createPhoneApi(), camera: createCameraApi() }));
  const [circle, setCircle] = useState<DemoCircle | null>(null);
  const { caretakers, location, route } = previewOptions;
  useEffect(() => {
    if (!preview) return;
    let live = true;
    void createPreviewPhone(preview, { caretakers, location, route }).then((p) => {
      if (!live) return;
      setApi(p.api);
      setCircle(p.circle);
    });
    return () => {
      live = false;
    };
  }, [preview, caretakers, location, route]);

  return (
    <div className={styles.root}>
      {preview ? (
        <p className={styles.preview} role="note">
          {PREVIEW_LINE}
        </p>
      ) : null}
      {api ? <Linked api={api} preview={preview !== null} circle={circle} start={start} /> : <Frame who={null} preview><Loading /></Frame>}
    </div>
  );
}

function Frame({ who, preview, children }: { who: string | null; preview: boolean; children: React.ReactNode }) {
  return (
    <>
      <header className={styles.bar}>
        <span className={styles.brand}>
          <WalkerMark size={28} />
          {PRODUCT_NAME}
        </span>
        {preview ? <span className={styles.tag}>Preview</span> : null}
        {who ? <span className={styles.barWho}>{who}</span> : null}
      </header>
      <main id="main" className={styles.main}>
        {children}
      </main>
    </>
  );
}

function Loading() {
  return (
    <section className={styles.screen} aria-labelledby={HEADING}>
      <h1 id={HEADING} tabIndex={-1} className={styles.title}>
        Opening Sophi
      </h1>
    </section>
  );
}

/** Who's holding this phone, in the header: "Rose's phone". */
const whoLine = (home: PhoneHome | null) => (home?.membership === "member" ? `${home.me.name}'s phone` : null);

function Linked({ api, preview, circle, start }: { api: PhoneApi; preview: boolean; circle: DemoCircle | null; start?: StartScreen }) {
  const phone = usePhone(api);
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });
  const announce = (text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 }));

  // A message that arrives while the app is open is read once, politely.
  const known = useRef<Set<string> | null>(null);
  const home = phone.home;
  useEffect(() => {
    if (home?.membership !== "member") return;
    const ids = home.messages.map((m) => m.message_id);
    if (known.current) {
      const arrived = home.messages.filter((m) => !m.mine && !known.current!.has(m.message_id));
      for (const m of arrived) announce(`New message from ${m.from_name}: ${m.text}`);
    }
    known.current = new Set(ids);
  }, [home]);

  // A request for help: each change (asked, someone coming, closed) is said once, compared with the last home's
  // request (`undefined` until the first home, so nothing is said on load). On a caretaker's phone a new request
  // also plays the tone and vibrates. Focus stays where it is.
  const lastHelp = useRef<HelpView | null | undefined>(undefined);
  useEffect(() => {
    if (home?.membership !== "member") {
      // Unlinked or waiting: a later link starts fresh, so its first home is a load again (nothing said).
      lastHelp.current = undefined;
      return;
    }
    const prev = lastHelp.current;
    lastHelp.current = home.help;
    if (prev === home.help) return;
    const line = helpChange(prev, home.help, home);
    if (line) announce(line);
    if (home.me.role === "caregiver" && helpArrived(prev, home.help)) {
      playHelpTone();
      buzz();
    }
  }, [home]);

  // A caretaker's phone: the first tap unlocks audio for the tone, and the tab title says so while a request is open.
  const caretaker = home?.membership === "member" && home.me.role === "caregiver";
  useEffect(() => (caretaker ? unlockAudioOnFirstTap() : undefined), [caretaker]);
  const openTitle = home?.membership === "member" && home.me.role === "caregiver" && home.help && !home.help.closed ? helpTitle(herName(home), home.help) : null;
  useEffect(() => {
    if (!openTitle) return;
    const before = document.title;
    document.title = openTitle;
    return () => {
      document.title = before;
    };
  }, [openTitle]);

  // The view changing under her (linked, approved, removed) moves focus to the new heading; not on first load.
  const view = home?.membership === "member" ? `member/${home.me.role}` : `${phone.phase}/${home?.membership ?? ""}`;
  const lastView = useRef(view);
  useLayoutEffect(() => {
    const before = lastView.current;
    lastView.current = view;
    if (before === view || before.startsWith("loading")) return;
    const h = document.querySelector<HTMLElement>("main h1");
    h?.focus();
  }, [view]);

  return (
    <Frame who={whoLine(home)} preview={preview}>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement.text}
        {announcement.n % 2 ? "​" : ""}
      </p>
      {phone.unreachable ? <p className={styles.alert}>{CANT_REACH}</p> : null}
      {phone.phase === "loading" ? <Loading /> : null}
      {phone.phase === "join" ? <Join phone={phone} /> : null}
      {phone.phase === "home" && home ? <Home phone={phone} home={home} api={api} announce={announce} start={start} /> : null}
      {circle && home?.membership === "member" ? <PreviewControls circle={circle} home={home} refresh={phone.refresh} /> : null}
    </Frame>
  );
}

export function Home({ phone, home, api, announce, start }: { phone: Phone; home: PhoneHome; api: PhoneApi; announce(text: string): void; start?: StartScreen }) {
  if (home.membership === "waiting") {
    return (
      <section className={styles.screen} aria-labelledby={HEADING}>
        <h1 id={HEADING} tabIndex={-1} className={styles.title}>
          Waiting for the family to approve
        </h1>
        <p className={styles.lead}>
          The code worked. Someone with the walker page approves {home.name}&apos;s phone there, after asking the person who uses the walker.
        </p>
        <p className={styles.meta}>This screen moves on by itself.</p>
      </section>
    );
  }
  if (home.membership === "no_answer") {
    return (
      <section className={styles.screen} aria-labelledby={HEADING}>
        <h1 id={HEADING} tabIndex={-1} className={styles.title}>
          Not approved yet
        </h1>
        <p className={styles.lead}>Ask again later. Nothing was shared. With a new code, this phone can try again.</p>
        <button type="button" className={styles.primary} onClick={phone.startOver}>
          Type a new code
        </button>
      </section>
    );
  }
  return home.me.role === "walker_user" ? (
    <RosePhone home={home} api={api} refresh={phone.refresh} announce={announce} initialScreen={start} />
  ) : (
    <MayaPhone home={home} api={api} refresh={phone.refresh} announce={announce} initialScreen={start} />
  );
}

export function Join({ phone }: { phone: Pick<Phone, "join" | "joining" | "notice"> }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (phone.joining) return;
    if (code.length !== 6) {
      setError("The code has 6 digits.");
      input.current?.focus();
      return;
    }
    const failed = await phone.join(code);
    if (failed) {
      setError(failed);
      input.current?.focus();
    }
  }

  const described = ["join-notice", error ? "join-error" : null].filter(Boolean).join(" ");
  return (
    <section className={styles.screen} aria-labelledby={HEADING}>
      <h1 id={HEADING} tabIndex={-1} className={styles.title}>
        Link this phone to a walker
      </h1>
      {phone.notice ? <p className={styles.lasting}>{phone.notice}</p> : null}
      <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
        <label className={styles.label} htmlFor="join-code">
          Code from the walker page
        </label>
        <input
          ref={input}
          id="join-code"
          className={styles.codeInput}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          value={code}
          aria-invalid={error ? true : undefined}
          aria-describedby={described}
          onChange={(e) => {
            setCode(codeDigits(e.target.value));
            if (error) setError(null);
          }}
        />
        {error ? (
          <p id="join-error" className={styles.alert} role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className={styles.primary} aria-disabled={phone.joining || undefined}>
          {phone.joining ? "Linking" : "Link this phone"}
        </button>
        <p id="join-notice" className={styles.meta}>
          {JOIN_NOTICE}
        </p>
      </form>
    </section>
  );
}

/**
 * Preview only: buttons that play the other side of a request for help on the fake circle (the walker asks, a
 * caretaker answers, her walker's Confirm twice, an hour passing). Dashed and labelled, under the app, never on stage.
 */
function PreviewControls({ circle, home, refresh }: { circle: DemoCircle; home: Extract<PhoneHome, { membership: "member" }>; refresh(): Promise<void> }) {
  const [line, setLine] = useState("");
  const caretakers = home.people.filter((p) => p.role === "caregiver").map((p) => p.name);
  const do_ = (label: string, act: () => unknown) => () => {
    try {
      act();
      setLine(`Done: ${label}.`);
    } catch (e) {
      setLine(`${label}: ${e instanceof Error ? e.message : "failed"}.`);
    }
    void refresh();
  };
  const controls: [string, () => unknown][] = [
    ["The walker asks", () => circle.walkerAsks("handles")],
    ["Asks by voice", () => circle.walkerAsks("voice")],
    ["Walker saw a fall", () => circle.walkerAsks("camera")],
    ...caretakers.map((n): [string, () => unknown] => [`${n}: on my way`, () => circle.caretakerAnswers(n, "coming")]),
    ...caretakers.slice(0, 1).map((n): [string, () => unknown] => [`${n}: with Rose`, () => circle.caretakerAnswers(n, "with_her")]),
    ["Rose: okay (walker)", () => circle.walkerOkay()],
    ["An hour passes", () => circle.advance(60 * 60_000)],
  ];
  return (
    <section className={styles.previewControls} aria-labelledby="preview-controls">
      <h2 id="preview-controls" className={styles.cardTitle}>
        Preview controls <span className={styles.tag}>Preview</span>
      </h2>
      <div className={styles.previewButtons}>
        {controls.map(([label, act]) => (
          <button key={label} type="button" className={styles.secondary} onClick={do_(label, act)}>
            {label}
          </button>
        ))}
      </div>
      <p className={styles.meta}>{line}</p>
    </section>
  );
}
