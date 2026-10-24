"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import type { ModuleId, QuestionId, SessionKind, SessionView, TurnInput } from "@walker/contracts";
import * as api from "./api";

/**
 * One hook owns the onboarding flow: loading and restoring the session, every call to the API, and
 * the single status line that screen readers hear. Components render from it and call its actions.
 */

const STORAGE_KEY = "walker.demo-session";

function readStoredId(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeId(id: string | null) {
  try {
    if (id) window.sessionStorage.setItem(STORAGE_KEY, id);
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private windows can refuse storage; the session still works until the page is closed.
  }
}

export type Phase = "loading" | "none" | "ready";

// One-shot, set by reset(navigate) just before it leaves the page. The screen that mounts next knows
// the session was just deleted, so it starts on "none" rather than "loading" and can move focus in its
// first commit. Module state: it survives a client-side navigation and is gone after a full page load.
let leavingAfterReset = false;

export interface Onboarding {
  phase: Phase;
  session: SessionView | null;
  busy: boolean;
  /** Polite announcement: what just happened. */
  status: string;
  /** Assertive announcement: what went wrong and what to do. */
  error: string | null;
  /** Changes whenever a new question appears, so the screen can move focus to it. */
  questionKey: number;
  /**
   * True on the screen that reset(navigate) opened. The previous screen deleted the session and took
   * the focused button with it, so this screen places focus itself.
   */
  arrivedAfterReset: boolean;
  start(): Promise<void>;
  answer(questionId: QuestionId, optionIds: string[], text: string): Promise<boolean>;
  skip(questionId: QuestionId): Promise<void>;
  skipRest(): Promise<void>;
  revisit(questionId: QuestionId): Promise<void>;
  updateFact(factId: string, text: string): Promise<boolean>;
  removeFact(factId: string, text: string): Promise<void>;
  confirm(selected: ModuleId[]): Promise<boolean>;
  /**
   * Deletes the session on the server. False (with an error) if it couldn't, so nothing is cleared.
   * With `navigate` (a router.push), a successful delete clears the session and navigates in one
   * transition, so this screen and its pressed button stay until the next screen replaces them; that
   * screen starts with phase "none" and `arrivedAfterReset` set.
   */
  reset(navigate?: () => void): Promise<boolean>;
  clearError(): void;
}

export interface OnboardingOptions {
  /** The kind of session Start creates: "account" when the user is signed in and saw the account notice. */
  notice?: SessionKind;
  /** A signed-in user's unfinished account session, resumed when this tab has none of its own (another device). */
  resumeId?: string | null;
}

export function useOnboarding({ notice = "demo", resumeId = null }: OnboardingOptions = {}): Onboarding {
  // An account session waiting to be resumed still loads as usual after a reset.
  const [arrivedAfterReset] = useState(() => leavingAfterReset && !resumeId);
  const [phase, setPhase] = useState<Phase>(arrivedAfterReset ? "none" : "loading");
  const [session, setSession] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [questionKey, setQuestionKey] = useState(0);
  const sessionRef = useRef<SessionView | null>(null);
  const lastQuestion = useRef<string | null>(null);

  const apply = useCallback((next: SessionView) => {
    sessionRef.current = next;
    setSession(next);
    setPhase("ready");
    const q = next.current_question ? `${next.current_question.id}:${next.turns.length}` : `none:${next.state}`;
    if (q !== lastQuestion.current) {
      lastQuestion.current = q;
      setQuestionKey((k) => k + 1);
    }
  }, []);

  useEffect(() => {
    leavingAfterReset = false;
    // The session was just deleted and its stored id cleared, so there is nothing to restore.
    if (arrivedAfterReset) return;
    const id = readStoredId() ?? resumeId;
    if (!id) {
      setPhase("none");
      return;
    }
    api
      .getSession(id)
      .then((s) => {
        storeId(s.session_id);
        lastQuestion.current = s.current_question ? `${s.current_question.id}:${s.turns.length}` : `none:${s.state}`;
        sessionRef.current = s;
        setSession(s);
        setPhase("ready");
      })
      .catch(() => {
        storeId(null);
        setPhase("none");
      });
  }, [arrivedAfterReset, resumeId]);

  const run = useCallback(
    async <T,>(fn: (s: SessionView) => Promise<T>): Promise<T | undefined> => {
      const current = sessionRef.current;
      if (!current) return undefined;
      setBusy(true);
      setError(null);
      try {
        return await fn(current);
      } catch (e) {
        if (e instanceof api.ApiRequestError) {
          if (e.code === "not_found" || e.code === "session_expired") {
            storeId(null);
            sessionRef.current = null;
            setSession(null);
            setPhase("none");
            setStatus(e.message);
          } else {
            if (e.session) apply(e.session);
            setError(e.message);
          }
        } else {
          setError("Something went wrong. Please try again.");
        }
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  const turn = useCallback(
    async (input: TurnInput) => {
      const r = await run((s) => api.sendTurn(s, input));
      if (!r) return false;
      apply(r.session);
      setStatus(r.ack ?? r.assistant_text);
      return true;
    },
    [run, apply],
  );

  return {
    phase,
    session,
    busy,
    status,
    error,
    questionKey,
    arrivedAfterReset,
    clearError: () => setError(null),
    async start() {
      setBusy(true);
      setError(null);
      try {
        const r = await api.startSession(notice);
        storeId(r.session.session_id);
        apply(r.session);
        setStatus("Setup started.");
      } catch (e) {
        setError(e instanceof api.ApiRequestError ? e.message : "Couldn't start. Please try again.");
      } finally {
        setBusy(false);
      }
    },
    answer: (questionId, optionIds, text) =>
      turn({ type: "answer", question_id: questionId, option_ids: optionIds, ...(text.trim() ? { text: text.trim() } : {}) }),
    async skip(questionId) {
      await turn({ type: "skip", question_id: questionId });
    },
    async skipRest() {
      await turn({ type: "skip_rest" });
    },
    async revisit(questionId) {
      await turn({ type: "revisit", question_id: questionId });
    },
    async updateFact(factId, text) {
      const next = await run((s) => api.editProfile(s, { type: "update", fact_id: factId, text }));
      if (!next) return false;
      apply(next);
      setStatus("Updated. Suggestions now follow your change.");
      return true;
    },
    async removeFact(factId, text) {
      const next = await run((s) => api.editProfile(s, { type: "remove", fact_id: factId }));
      if (!next) return;
      apply(next);
      setStatus(`Removed: ${text}.`);
    },
    async confirm(selected) {
      const next = await run((s) => api.confirmSelection(s, selected));
      if (!next) return false;
      apply(next);
      // An account setup now lives in Your setups; this tab is free to start another one.
      if (next.kind === "account") storeId(null);
      setStatus("Your setup is saved.");
      return true;
    },
    async reset(navigate) {
      const current = sessionRef.current;
      setBusy(true);
      setError(null);
      try {
        if (current) await api.deleteSession(current.session_id);
      } catch (e) {
        // Already gone (expired or deleted elsewhere) is what the user asked for; anything else isn't.
        if (!(e instanceof api.ApiRequestError && e.code === "not_found")) {
          const message = "Your answers couldn't be deleted just now. Please try again.";
          setError(message);
          setStatus(message);
          setBusy(false);
          return false;
        }
      }
      storeId(null);
      sessionRef.current = null;
      lastQuestion.current = null;
      const clear = () => {
        setSession(null);
        setPhase("none");
        setBusy(false);
        setStatus("Your answers were deleted.");
      };
      if (navigate) {
        // router.push is a transition that waits for the next page; clearing in the same one means
        // React never shows this screen without its session ("No setup in progress") on the way.
        leavingAfterReset = true;
        startTransition(() => {
          clear();
          navigate();
        });
      } else {
        clear();
      }
      return true;
    },
  };
}
