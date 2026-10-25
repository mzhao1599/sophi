"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { PRODUCT_NAME } from "@/lib/brand";
import { createCameraApi } from "@/lib/cameraApi";
import { createPhoneApi, type PhoneApi, type PhoneHome, type PhoneRole } from "@/lib/phoneApi";
import { createPreviewPhone } from "@/lib/phoneFake";
import { CANT_REACH, JOIN_NOTICE, codeDigits } from "@/lib/phoneView";
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
 * already linked, and says "Preview" on every screen.
 */
export function PhoneApp({ preview = null }: { preview?: PhoneRole | null }) {
  const [api, setApi] = useState<PhoneApi | null>(() => (preview ? null : { ...createPhoneApi(), camera: createCameraApi() }));
  useEffect(() => {
    if (!preview) return;
    let live = true;
    void createPreviewPhone(preview).then((p) => live && setApi(p.api));
    return () => {
      live = false;
    };
  }, [preview]);

  return (
    <div className={styles.root}>
      {preview ? (
        <p className={styles.preview} role="note">
          {PREVIEW_LINE}
        </p>
      ) : null}
      {api ? <Linked api={api} preview={preview !== null} /> : <Frame who={null} preview><Loading /></Frame>}
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

function Linked({ api, preview }: { api: PhoneApi; preview: boolean }) {
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
      {phone.phase === "home" && home ? <Home phone={phone} home={home} api={api} announce={announce} /> : null}
    </Frame>
  );
}

export function Home({ phone, home, api, announce }: { phone: Phone; home: PhoneHome; api: PhoneApi; announce(text: string): void }) {
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
    <RosePhone home={home} api={api} refresh={phone.refresh} announce={announce} />
  ) : (
    <MayaPhone home={home} api={api} refresh={phone.refresh} announce={announce} />
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
