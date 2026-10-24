"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Deletes this tab's demo session, if it has one, and forgets it, for "Set up another walker" on the
 * pages after checkout. True when nothing is left (already gone counts); false if the server refused,
 * so nothing is forgotten. A saved account setup is never here: confirming one already forgot it.
 */
export async function forgetStoredSession(): Promise<boolean> {
  const id = readStoredId();
  if (id) {
    try {
      await api.deleteSession(id);
    } catch (e) {
      if (!(e instanceof api.ApiRequestError && e.code === "not_found")) return false;
    }
  }
  storeId(null);
  return true;
}

export type Phase = "loading" | "none" | "ready";

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
  /** Starts a session with the notice the screen showed; the new session, or null (with an error) if it couldn't. */
  start(): Promise<SessionView | null>;
  answer(questionId: QuestionId, optionIds: string[], text: string): Promise<boolean>;
  skip(questionId: QuestionId): Promise<boolean>;
  skipRest(): Promise<boolean>;
  revisit(questionId: QuestionId): Promise<boolean>;
  confirm(selected: ModuleId[]): Promise<boolean>;
  /** Deletes the session on the server. False (with an error) if it couldn't, so nothing is cleared. */
  reset(): Promise<boolean>;
  clearError(): void;
}

export interface OnboardingOptions {
  /** The kind of session Start creates: "account" when the user is signed in and saw the account notice. */
  notice?: SessionKind;
  /** A signed-in user's unfinished account session, resumed when this tab has none of its own (another device). */
  resumeId?: string | null;
}

export function useOnboarding({ notice = "demo", resumeId = null }: OnboardingOptions = {}): Onboarding {
  const [phase, setPhase] = useState<Phase>("loading");
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
  }, [resumeId]);

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
    clearError: () => setError(null),
    async start() {
      setBusy(true);
      setError(null);
      try {
        const r = await api.startSession(notice);
        storeId(r.session.session_id);
        apply(r.session);
        setStatus("Setup started.");
        return r.session;
      } catch (e) {
        setError(e instanceof api.ApiRequestError ? e.message : "Couldn't start. Please try again.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    answer: (questionId, optionIds, text) =>
      turn({ type: "answer", question_id: questionId, option_ids: optionIds, ...(text.trim() ? { text: text.trim() } : {}) }),
    skip: (questionId) => turn({ type: "skip", question_id: questionId }),
    skipRest: () => turn({ type: "skip_rest" }),
    revisit: (questionId) => turn({ type: "revisit", question_id: questionId }),
    async confirm(selected) {
      const next = await run((s) => api.confirmSelection(s, selected));
      if (!next) return false;
      apply(next);
      // An account setup now lives in Your setups; this tab is free to start another one.
      if (next.kind === "account") storeId(null);
      setStatus("Your setup is saved.");
      return true;
    },
    async reset() {
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
      setSession(null);
      setPhase("none");
      setBusy(false);
      setStatus("Your answers were deleted.");
      return true;
    },
  };
}
