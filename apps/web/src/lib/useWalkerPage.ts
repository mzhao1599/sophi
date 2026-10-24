"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WalkerStatusView } from "@walker/contracts";
import { WalkerApiError, type WalkerFailure, type WalkerPageApi } from "./walkerApi";
import {
  CONNECTION_BACK,
  CONNECTION_LOST,
  NOT_LIVE_AFTER_MS,
  POLL_MS,
  announcements,
  answeredCard,
  errorMessage,
  goneMessage,
  nextCard,
  type Heard,
  type ProposalCard,
} from "./walkerView";

export type WalkerPhase = "loading" | "none" | "paired";

export interface WalkerModel {
  phase: WalkerPhase;
  walkers: WalkerStatusView[];
  selectedId: string | null;
  /** This browser's clock when the shown status arrived, and when a poll last succeeded. */
  receivedAtMs: number;
  lastOkAtMs: number;
  /** Why the last poll failed, while polls are failing. */
  pollFailure: WalkerFailure | null;
  /** Polls have failed for longer than NOT_LIVE_AFTER_MS, and that was announced. */
  disconnected: boolean;
  /** A lasting line: the cookie went, or the walker was forgotten elsewhere. */
  notice: string | null;
  /** The code on screen, with its expiry on the server's clock. */
  pairing: { code: string; expiresAtMs: number } | null;
  pairingBusy: boolean;
  pairingError: string | null;
  card: ProposalCard | null;
  answering: "confirm" | "decline" | null;
  answerError: string | null;
  /** The words being sent, shown as "You typed" until the answer arrives. */
  sending: string | null;
  sendError: string | null;
  forgetting: boolean;
  forgetError: string | null;
  /** For the polite live region; `n` changes so the same words twice are still read. */
  announcement: { text: string; n: number };
  /** Turns that were already there when the page loaded: they don't replay their reveal. */
  oldTurns: Set<string>;
}

export interface WalkerPage extends WalkerModel {
  walker: WalkerStatusView | null;
  serverNow(): number;
  select(id: string): void;
  getCode(): Promise<void>;
  send(text: string): Promise<boolean>;
  answer(kind: "confirm" | "decline"): Promise<boolean>;
  forget(): Promise<boolean>;
  /** Clears an old Forget error before the dialog opens again. */
  resetForget(): void;
  pollNow(): void;
}

const START: WalkerModel = {
  phase: "loading",
  walkers: [],
  selectedId: null,
  receivedAtMs: 0,
  lastOkAtMs: 0,
  pollFailure: null,
  disconnected: false,
  notice: null,
  pairing: null,
  pairingBusy: false,
  pairingError: null,
  card: null,
  answering: null,
  answerError: null,
  sending: null,
  sendError: null,
  forgetting: false,
  forgetError: null,
  announcement: { text: "", n: 0 },
  oldTurns: new Set(),
};

const codeOf = (e: unknown): WalkerFailure => (e instanceof WalkerApiError ? e.code : "network");

/**
 * Whether focus is on the offer's buttons (`data-offer-actions` in WalkerConversation). When they go,
 * focus moves to the card's heading, which names the outcome, so the live region stays quiet about it.
 * Anywhere else (even the card's heading), the live region reads it.
 */
const focusInOffer = () => typeof document !== "undefined" && Boolean(document.activeElement?.closest("[data-offer-actions]"));

/** A random id for a turn. `crypto.randomUUID` needs a secure context; a page served over plain HTTP gets the same from random bytes. */
function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The "Your walker" page's state: polls the owner's walkers every POLL_MS while the tab is visible,
 * and runs the page's four actions (get a pairing code, send a typed question, answer a proposal,
 * forget the walker). Polls never overlap, and a poll that started before an action's answer arrived is
 * dropped, so an older status never replaces a newer one.
 */
export function useWalkerPage(api: WalkerPageApi): WalkerPage {
  const model = useRef<WalkerModel>(START);
  const [, render] = useState(0);
  const heard = useRef(new Map<string, Heard>());
  // Bumped whenever an action's answer is applied: a poll that began before then is out of date.
  const epoch = useRef(0);
  const retry = useRef<{ device: string; text: string; id: string } | null>(null);
  const pollRef = useRef<() => void>(() => undefined);

  const update = useCallback((patch: Partial<WalkerModel> | ((m: WalkerModel) => Partial<WalkerModel>)) => {
    const m = model.current;
    model.current = { ...m, ...(typeof patch === "function" ? patch(m) : patch) };
    render((n) => n + 1);
  }, []);

  const serverNow = useCallback(() => Date.now() + api.clockOffsetMs(), [api]);

  const announce = (m: WalkerModel, lines: string[]): Partial<WalkerModel> =>
    lines.length ? { announcement: { text: lines.join(" "), n: m.announcement.n + 1 } } : {};

  /**
   * Applies a fresh list of walkers: selection, pairing, the proposal card and what to read out. `card`
   * is an action's answer for the walker `card.for`; `first` is read before any news in this list.
   */
  const applyList = useCallback(
    (walkers: WalkerStatusView[], card?: { for: string; card: ProposalCard }, first: string[] = []) => {
      update((m) => {
        const lines: string[] = [...first];
        const knew = new Set(m.walkers.map((w) => w.device_id));
        const added = m.phase === "loading" ? undefined : walkers.find((w) => !knew.has(w.device_id));
        let selectedId = added?.device_id ?? (walkers.some((w) => w.device_id === m.selectedId) ? m.selectedId : (walkers[0]?.device_id ?? null));
        if (added) lines.push(`Paired with ${added.name}.`);
        const selected = walkers.find((w) => w.device_id === selectedId) ?? null;
        if (!selected) selectedId = null;

        const oldTurns = new Set(m.oldTurns);
        for (const w of walkers) {
          const before = heard.current.get(w.device_id);
          if (!before && m.phase === "loading") w.turns.forEach((t) => oldTurns.add(t.turn_id));
          const said = announcements(before, w);
          heard.current.set(w.device_id, said.heard);
          if (w.device_id === selectedId) lines.push(...said.lines);
        }
        const sameWalker = selectedId === m.selectedId;
        // An action's card applies only to the walker it was for, and only if that walker is still the one shown.
        const own = card && selected && card.for === selected.device_id ? card.card : undefined;
        const nextProposal = selected ? (own ?? nextCard(sameWalker ? m.card : null, selected, serverNow())) : null;
        const newOffer = nextProposal?.proposal.proposal_id !== m.card?.proposal.proposal_id;
        // The shown offer closed elsewhere: read how, unless focus is in the card, whose heading says it.
        // (An answer from this page brings its own line in `first`.)
        const closed = !own && !newOffer && m.card?.outcome === null && nextProposal?.outcome;
        if (closed && !focusInOffer()) lines.push(closed);
        return {
          phase: walkers.length ? "paired" : "none",
          walkers,
          selectedId,
          receivedAtMs: Date.now(),
          pairing: added ? null : m.pairing,
          pairingError: added ? null : m.pairingError,
          notice: added ? null : m.notice,
          card: nextProposal,
          ...(sameWalker ? {} : { answerError: null, sendError: null }),
          ...(newOffer ? { answerError: null } : {}),
          oldTurns,
          ...announce(m, lines),
        };
      });
    },
    [update, serverNow],
  );

  /**
   * One walker's status from an action's answer, in place of its entry in the list. A walker no longer in
   * the list (forgotten meanwhile) stays gone. A poll follows at once, in case a poll already applied
   * was newer than this answer.
   */
  const applyStatus = useCallback(
    (status: WalkerStatusView, card?: ProposalCard, first: string[] = []) => {
      if (!model.current.walkers.some((w) => w.device_id === status.device_id)) return;
      epoch.current += 1;
      applyList(
        model.current.walkers.map((w) => (w.device_id === status.device_id ? status : w)),
        card ? { for: status.device_id, card } : undefined,
        // An action's own line is about this walker: not read if another one is shown now.
        status.device_id === model.current.selectedId ? first : [],
      );
      pollRef.current();
    },
    [applyList],
  );

  /** The cookie is gone: back to "Connect a walker". */
  const signedOut = useCallback(
    (wasPaired: boolean) => {
      epoch.current += 1;
      heard.current.clear();
      update({
        phase: "none",
        walkers: [],
        selectedId: null,
        card: null,
        lastOkAtMs: Date.now(),
        pollFailure: null,
        notice: wasPaired ? errorMessage("unauthenticated") : model.current.notice,
      });
    },
    [update],
  );

  /** Errors every action shares: the cookie went, or the walker did. Returns the message for anything else. */
  const common = useCallback(
    (e: unknown, walkerName: string): string | null => {
      const code = codeOf(e);
      if (code === "unauthenticated") {
        signedOut(true);
        return null;
      }
      if (code === "not_found") {
        update({ notice: goneMessage(walkerName) });
        pollRef.current();
        return null;
      }
      return errorMessage(code);
    },
    [signedOut, update],
  );

  // ---- Polling ----
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;

    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = setTimeout(run, POLL_MS);
    };
    async function run() {
      clearTimeout(timer);
      if (stopped || document.hidden || controller) return;
      const started = epoch.current;
      const mine = new AbortController();
      controller = mine;
      try {
        const walkers = await api.listWalkers(mine.signal);
        if (stopped || mine.signal.aborted) return;
        const back = model.current.disconnected ? [CONNECTION_BACK] : [];
        update({ lastOkAtMs: Date.now(), pollFailure: null, disconnected: false });
        // Read before this poll's news, so the news can't overwrite it.
        if (started === epoch.current) applyList(walkers, undefined, back);
        else if (back.length) update((m) => announce(m, back));
      } catch (e) {
        if (stopped || mine.signal.aborted) return;
        const code = codeOf(e);
        if (code === "unauthenticated") signedOut(model.current.phase === "paired");
        // Before the first answer the page can't know whether there is a walker, so it stays on
        // "Loading" with the error rather than inviting a pairing code the server can't give. Once
        // what's on screen is out of date, that's said once.
        else
          update((m) => {
            const lost = !m.disconnected && m.phase !== "loading" && Date.now() - m.lastOkAtMs > NOT_LIVE_AFTER_MS;
            return { pollFailure: code, ...(lost ? { disconnected: true, ...announce(m, [CONNECTION_LOST]) } : {}) };
          });
      } finally {
        if (controller === mine) controller = null;
        if (!mine.signal.aborted) schedule();
      }
    }
    const onVisibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        controller?.abort();
        controller = null;
      } else void run();
    };
    pollRef.current = () => void run();
    document.addEventListener("visibilitychange", onVisibility);
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      pollRef.current = () => undefined;
    };
  }, [api, applyList, signedOut, update]);

  // ---- Actions ----

  const getCode = useCallback(async () => {
    if (model.current.pairingBusy) return;
    update({ pairingBusy: true, pairingError: null });
    try {
      const code = await api.createPairingCode();
      // Not announced: focus moves to the code, which reads it once.
      update({ pairing: { code: code.code, expiresAtMs: Date.parse(code.expires_at) }, pairingBusy: false, notice: null });
      pollRef.current();
    } catch (e) {
      update({ pairingBusy: false, pairingError: errorMessage(codeOf(e)) });
    }
  }, [api, update]);

  const send = useCallback(
    async (text: string) => {
      const m = model.current;
      const w = m.walkers.find((x) => x.device_id === m.selectedId);
      const words = text.trim();
      if (!w || m.sending !== null || !words) return false;
      // The same words again after a failure keep their id, so a reply that did arrive isn't run twice.
      const same = retry.current?.device === w.device_id && retry.current.text === words;
      update({ sending: words, sendError: null });
      try {
        const id = same ? retry.current!.id : newId();
        retry.current = { device: w.device_id, text: words, id };
        const r = await api.sendTurn(w.device_id, id, words);
        retry.current = null;
        update({ sending: null });
        applyStatus(r.status);
        return true;
      } catch (e) {
        update({ sending: null, sendError: common(e, w.name) });
        return false;
      }
    },
    [api, applyStatus, common, update],
  );

  const answer = useCallback(
    async (kind: "confirm" | "decline") => {
      const m = model.current;
      const w = m.walkers.find((x) => x.device_id === m.selectedId);
      const card = m.card;
      if (!w || !card || card.outcome !== null || m.answering) return false;
      update({ answering: kind, answerError: null });
      try {
        const r = await api.answerProposal(w.device_id, card.proposal.proposal_id, kind);
        update({ answering: null });
        // Read by the card's heading when focus is in the card (it moves there), otherwise here, once.
        const done = answeredCard(r.proposal, r.status);
        applyStatus(r.status, done, done.outcome && !focusInOffer() ? [done.outcome] : []);
        return true;
      } catch (e) {
        if (e instanceof WalkerApiError && e.code === "proposal_closed" && e.proposal) {
          const done = answeredCard(e.proposal, w);
          epoch.current += 1;
          update((now) =>
            now.selectedId === w.device_id
              ? { answering: null, card: done, ...announce(now, done.outcome && !focusInOffer() ? [done.outcome] : []) }
              : { answering: null },
          );
          return true;
        }
        update({ answering: null, answerError: common(e, w.name) });
        return false;
      }
    },
    [api, applyStatus, common, update],
  );

  const forget = useCallback(async () => {
    const m = model.current;
    const w = m.walkers.find((x) => x.device_id === m.selectedId);
    if (!w || m.forgetting) return false;
    update({ forgetting: true, forgetError: null });
    try {
      try {
        await api.forgetWalker(w.device_id);
      } catch (e) {
        // Already gone (forgotten in another tab) is what Forget wanted.
        if (codeOf(e) !== "not_found") throw e;
      }
      epoch.current += 1;
      heard.current.delete(w.device_id);
      const rest = model.current.walkers.filter((x) => x.device_id !== w.device_id);
      update((now) => ({
        forgetting: false,
        walkers: rest,
        selectedId: rest[0]?.device_id ?? null,
        phase: rest.length ? "paired" : "none",
        card: null,
        ...announce(now, [`Forgot ${w.name}.`]),
      }));
      if (rest[0]) applyList(rest);
      return true;
    } catch (e) {
      update({ forgetting: false, forgetError: common(e, w.name) });
      return false;
    }
  }, [api, applyList, common, update]);

  const resetForget = useCallback(() => update({ forgetError: null }), [update]);

  const select = useCallback(
    (id: string) => {
      const m = model.current;
      if (id === m.selectedId) return;
      const w = m.walkers.find((x) => x.device_id === id);
      update({ selectedId: id, card: w ? nextCard(null, w, serverNow()) : null, answerError: null, sendError: null });
    },
    [update, serverNow],
  );

  const m = model.current;
  const walker = useMemo(() => m.walkers.find((w) => w.device_id === m.selectedId) ?? null, [m.walkers, m.selectedId]);
  return { ...m, walker, serverNow, select, getCode, send, answer, forget, resetForget, pollNow: () => pollRef.current() };
}
