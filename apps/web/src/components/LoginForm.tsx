"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, type FormEvent } from "react";
import { START } from "@/lib/sign-in-state";
import { signIn } from "@/server/auth-actions";
import screen from "./Screen.module.css";
import styles from "./Account.module.css";

/**
 * Passwordless sign-in, in two steps: an email address, then the code from the email (or its link).
 * Every control is a native form element with a visible label; errors are announced and tied to
 * their field; when the step changes, focus moves to the new heading. Works without JavaScript too.
 */
export function LoginForm({ next, linkFailed, accountDeleted = false }: { next: string; linkFailed: boolean; accountDeleted?: boolean }) {
  const [state, action, pending] = useActionState(signIn, START);
  // Buttons stay focusable while a request runs (aria-disabled, as elsewhere in the app), so a press then is ignored here.
  const ignoreWhilePending = (event: FormEvent) => {
    if (pending) event.preventDefault();
  };
  const headingRef = useRef<HTMLHeadingElement>(null);
  const step = useRef(state.step);

  useEffect(() => {
    if (step.current !== state.step) headingRef.current?.focus();
    step.current = state.step;
  }, [state.step]);

  if (state.step === "email") {
    const error = state.error ?? (linkFailed ? "That sign-in link didn't work. It may have expired or been used already. Enter your email to get a new one." : null);
    return (
      <section aria-labelledby="login-heading">
        {accountDeleted ? (
          <p role="status" className={styles.notice}>
            Your account was deleted, with every saved setup and answer in it.
          </p>
        ) : null}
        <h1 id="login-heading" ref={headingRef} tabIndex={-1} className={`${screen.doneTitle} ${styles.focusTarget}`}>
          Sign in
        </h1>
        <p className={screen.lead}>
          Sign in to keep your setup in your account and come back to it on another device. There&apos;s no password: we email you a
          code and a link, and either one signs you in. New here? The same email creates your account.
        </p>
        <form action={action} onSubmit={ignoreWhilePending} className={styles.form} noValidate>
          <input type="hidden" name="intent" value="send" />
          <input type="hidden" name="next" value={next} />
          <label className="field-label" htmlFor="login-email">
            Email address
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            required
            defaultValue={state.email}
            className={styles.input}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "login-email-hint login-email-error" : "login-email-hint"}
          />
          <p id="login-email-hint" className="field-hint">
            We use it only to sign you in.
          </p>
          {error ? (
            <p id="login-email-error" role="alert" className={styles.error}>
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button type="submit" className="button button-primary" aria-disabled={pending || undefined}>
              {pending ? "Sending…" : "Email me a sign-in code"}
            </button>
          </div>
        </form>
        <p className={styles.meta}>
          Or <Link href="/onboarding">try the demo without an account</Link>. Demo answers are deleted after an hour.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="login-heading">
      <h1 id="login-heading" ref={headingRef} tabIndex={-1} className={`${screen.doneTitle} ${styles.focusTarget}`}>
        Check your email
      </h1>
      <p className={screen.lead}>
        We sent a sign-in code and a link to <strong>{state.email}</strong>. Type the code below, or open the link on the device
        you&apos;d like to use. Both work once and expire in an hour.
      </p>
      <p role="status" className={styles.notice}>
        {state.notice ?? ""}
      </p>
      <form action={action} onSubmit={ignoreWhilePending} className={styles.form} noValidate>
        <input type="hidden" name="intent" value="verify" />
        <input type="hidden" name="email" value={state.email} />
        <input type="hidden" name="next" value={next} />
        <label className="field-label" htmlFor="login-code">
          Code from the email
        </label>
        <input
          id="login-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={12}
          required
          className={`${styles.input} ${styles.code}`}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "login-code-hint login-code-error" : "login-code-hint"}
        />
        <p id="login-code-hint" className="field-hint">
          6 digits. Not there? Check your spam folder, or send a new email.
        </p>
        {state.error ? (
          <p id="login-code-error" role="alert" className={styles.error}>
            {state.error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <button type="submit" className="button button-primary" aria-disabled={pending || undefined}>
            {pending ? "Checking…" : "Sign in"}
          </button>
        </div>
      </form>
      <div className={styles.actions}>
        <form action={action} onSubmit={ignoreWhilePending}>
          <input type="hidden" name="intent" value="resend" />
          <input type="hidden" name="email" value={state.email} />
          <input type="hidden" name="next" value={next} />
          <button type="submit" className="button button-secondary" aria-disabled={pending || undefined}>
            Send a new email
          </button>
        </form>
        <form action={action} onSubmit={ignoreWhilePending}>
          <input type="hidden" name="intent" value="change" />
          <input type="hidden" name="email" value={state.email} />
          <button type="submit" className="button-text" aria-disabled={pending || undefined}>
            Use a different email
          </button>
        </form>
      </div>
    </section>
  );
}
