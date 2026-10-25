"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { membershipMoved, openLive, phoneRows, withLiveCircle, PHONE_VIEWS, type LiveStatus, type PhoneLiveRows } from "./careLive";
import { PhoneApiError, type PhoneApi, type PhoneFailure, type PhoneHome } from "./phoneApi";
import { NOT_IN_CIRCLE, PHONE_LIVE_POLL_MS, PHONE_POLL_MS, joinError } from "./phoneView";

/**
 * One hook owns the phone's talk with the server: the first load, polling every PHONE_POLL_MS while the
 * page is visible (one request at a time), joining, and a refresh after each send. The screens only read
 * `phone` and call its functions. When the server keeps the circle in SpacetimeDB, the hook also holds a live
 * connection (careLive.ts): people and messages then come pushed, a change of membership refreshes at once,
 * and polling slows to PHONE_LIVE_POLL_MS for the walker's status.
 */
export interface Phone {
  /** `loading` until the first answer; `join` when this phone isn't linked; `home` once the server sent a home. */
  phase: "loading" | "join" | "home";
  home: PhoneHome | null;
  /** The last poll got no answer: what's on screen is what the server said last. */
  unreachable: boolean;
  /** A lasting line on the join screen (for example: this phone was removed). */
  notice: string | null;
  joining: boolean;
  join(code: string): Promise<string | null>;
  /** Back to the code screen (after "Not approved in time"). */
  startOver(): void;
  refresh(): Promise<void>;
}

const failure = (e: unknown): PhoneFailure => (e instanceof PhoneApiError ? e.code : "network");

export function usePhone(api: PhoneApi): Phone {
  const [phase, setPhase] = useState<Phone["phase"]>("loading");
  const [home, setHome] = useState<PhoneHome | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [live, setLive] = useState<LiveStatus>("off");
  const [liveRows, setLiveRows] = useState<PhoneLiveRows | null>(null);
  const busy = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await api.home();
      setHome(next);
      setPhase("home");
      setUnreachable(false);
    } catch (e) {
      const code = failure(e);
      if (code === "unauthenticated") {
        // A phone that was linked and isn't any more says so; a fresh phone just shows the code screen.
        if (phaseRef.current === "home") setNotice(NOT_IN_CIRCLE);
        setHome(null);
        setPhase("join");
        setUnreachable(false);
      } else if (code === "not_offered") {
        setNotice(joinError("not_offered"));
        setPhase("join");
      } else {
        setUnreachable(true);
      }
    } finally {
      busy.current = false;
    }
  }, [api]);

  // The live connection, while this phone is linked (waiting or in). Its token names this phone's membership, which
  // stays the same from waiting to approved, so approval keeps the connection; leaving for the code screen closes it.
  const linked = phase === "home" && !!home && home.membership !== "no_answer";
  useEffect(() => {
    if (!linked || !api.live) return;
    const access = api.live.bind(api);
    const handle = openLive(
      access,
      PHONE_VIEWS,
      (conn) => {
        const rows = phoneRows(conn);
        setLiveRows(rows);
        // Kept in the home too, so when the live rows go (removed, reconnecting) the screen never steps back to an older poll.
        setHome((h) => withLiveCircle(h, rows));
      },
      setLive,
    );
    return () => {
      handle.close();
      setLive("off");
      setLiveRows(null);
    };
  }, [api, linked]);

  // Approved, removed, or replaced: what the live rows say about this phone wins, so ask the server now.
  useEffect(() => {
    if (live === "live" && membershipMoved(home, liveRows)) void refresh();
  }, [home, liveRows, live, refresh]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && phaseRef.current !== "join") void refresh();
    }, live === "live" ? PHONE_LIVE_POLL_MS : PHONE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && phaseRef.current !== "join") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, live]);

  const join = useCallback(
    async (code: string) => {
      if (joining) return null;
      setJoining(true);
      try {
        const next = await api.join(code);
        setHome(next);
        setNotice(null);
        setPhase("home");
        return null;
      } catch (e) {
        return joinError(failure(e));
      } finally {
        setJoining(false);
      }
    },
    [api, joining],
  );

  const startOver = useCallback(() => {
    setHome(null);
    setNotice(null);
    setPhase("join");
  }, []);

  // Only while live: a dropped connection's rows would hide what the polls bring meanwhile.
  const shown = useMemo(() => (live === "live" ? withLiveCircle(home, liveRows) : home), [home, liveRows, live]);
  return { phase, home: shown, unreachable, notice, joining, join, startOver, refresh };
}
