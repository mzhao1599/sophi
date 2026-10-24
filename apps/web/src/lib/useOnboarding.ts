"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ModuleId, QuestionId, SessionView, TurnInput } from "@walker/contracts";
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
  start(): Promise<void>;
  answer(questionId: QuestionId, optionIds: string[], text: string): Promise<boolean>;
  skip(questionId: QuestionId): Promise<void>;
  skipRest(): Promise<void>;
  revisit(questionId: QuestionId): Promise<void>;
  updateFact(factId: string, text: string): Promise<boolean>;
  removeFact(factId: string, text: string): Promise<void>;
  confirm(selected: ModuleId[]): Promise<boolean>;
  reset(): Promise<void>;
  clearError(): void;
}

export function useOnboarding(): Onboarding {
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
    const id = readStoredId();
    if (!id) {
      setPhase("none");
      return;
    }
    api
      .getSession(id)
      .then((s) => {
        lastQuestion.current = s.current_question ? `${s.current_question.id}:${s.turns.length}` : `none:${s.state}`;
        sessionRef.current = s;
        setSession(s);
        setPhase("ready");
      })
      .catch(() => {
        storeId(null);
        setPhase("none");
      });
  }, []);

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
        const r = await api.startSession();
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
      setStatus("Your setup is saved.");
      return true;
    },
    async reset() {
      const current = sessionRef.current;
      setBusy(true);
      try {
        if (current) await api.deleteSession(current.session_id).catch(() => undefined);
      } finally {
        storeId(null);
        sessionRef.current = null;
        lastQuestion.current = null;
        setSession(null);
        setPhase("none");
        setBusy(false);
        setStatus("Your answers were deleted.");
      }
    },
  };
}
