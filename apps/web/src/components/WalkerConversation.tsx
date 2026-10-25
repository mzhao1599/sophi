"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { WalkerModel, WalkerStatusView } from "@walker/contracts";
import { surge, useReducedMotion } from "@/lib/motion";
import { useNow } from "@/lib/useNow";
import type { WalkerPage } from "@/lib/useWalkerPage";
import { NOT_CAUGHT, OUT_OF_TIME, conversation, cueList, formatCountdown, secondsLeft, typedNotice } from "@/lib/walkerView";
import { Mark, Words } from "./Chat";
import demo from "./Demo.module.css";
import styles from "./Walker.module.css";

const MAX_TYPED = 500;

/**
 * The walker's conversation: what was said to it (by voice on the walker, or typed here), Sophi's
 * replies, and the lines the walker said on its own, oldest first. Below it, the open offer with
 * Confirm and Decline, the data notice, and the text box. The log isn't a live region: the page's one
 * polite region reads each new reply, line and offer once.
 */
export function WalkerConversation({ page, walker, typedBy }: { page: WalkerPage; walker: WalkerStatusView; typedBy: WalkerModel | null }) {
  const reduced = useReducedMotion();
  const ids = useId();
  const [text, setText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const entries = useMemo(() => conversation(walker), [walker]);
  const lastReply = entries.findLastIndex((e) => e.kind === "turn");
  const sending = page.sending !== null;
  const errorId = `${ids}-error`;

  // Keep the newest line in view, and let the ground move a little when Sophi answers.
  const newest = entries.at(-1)?.key;
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTo({ top: log.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [newest, sending, reduced, page.card?.proposal.proposal_id]);
  // Keyed on the newest turn's id, not the entry object, which is new on every poll.
  const newestTurn = entries.findLast((e) => e.kind === "turn");
  const newestTurnId = newestTurn?.kind === "turn" ? newestTurn.turn.turn_id : null;
  const oldTurns = useRef(page.oldTurns);
  oldTurns.current = page.oldTurns;
  useEffect(() => {
    if (newestTurnId && !oldTurns.current.has(newestTurnId)) surge();
  }, [newestTurnId]);
  // Whether focus is inside the offer: a newer offer is a new card, and focus on the old one's buttons
  // moves to the new card's heading, never onto a Confirm for an offer the person hasn't read.
  const focusInOffer = useRef(false);
  // A closed card goes when a newer turn arrives: focus that was in it moves to the text box.
  const inputRef = useRef<HTMLInputElement>(null);
  const hasCard = page.card !== null;
  useLayoutEffect(() => {
    if (hasCard || !focusInOffer.current) return;
    focusInOffer.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) inputRef.current?.focus({ preventScroll: true });
  }, [hasCard]);

  async function submit() {
    if (sending || !text.trim()) return;
    if (await page.send(text)) setText("");
  }

  return (
    <div className={`${demo.chat} ${styles.chatHeight}`}>
      <h2 id={`${ids}-heading`} className="visually-hidden">
        Conversation
      </h2>
      <div ref={logRef} className={demo.log} data-log tabIndex={0} role="region" aria-labelledby={`${ids}-heading`}>
        {entries.length === 0 && !sending ? <p className={styles.emptyLog}>Nothing said yet. Hold Talk on the walker, or type below.</p> : null}
        {entries.map((e, i) =>
          e.kind === "line" ? (
            <div key={e.key} className={styles.walkerLine}>
              <span className={styles.walkerMark} aria-hidden="true" />
              <div>
                <p className={styles.heardLabel}>{e.label}</p>
                <p className={styles.walkerText}>{e.event.text}</p>
                {e.event.text.startsWith("Your GPS puts you near ") ? <p className={styles.mapCredit}>Map data © OpenStreetMap contributors</p> : null}
              </div>
            </div>
          ) : (
            <div key={e.key} className={styles.turn}>
              <div className={styles.person}>
                <p className={styles.heardLabel}>{e.heardLabel}</p>
                <p className={demo.reply}>{e.heard ?? <span className={styles.notCaught}>{NOT_CAUGHT}</span>}</p>
              </div>
              <div className={demo.said}>
                <Mark state={i === lastReply ? (sending ? "past" : "live") : "past"} />
                <p className={demo.saidText}>
                  <span className="visually-hidden">Sophi: </span>
                  <Words text={e.turn.reply} animate={!reduced && !page.oldTurns.has(e.turn.turn_id)} />
                </p>
                {e.engineNote || e.voiceNote ? (
                  <p className={`${demo.engine} ${styles.notes}`}>
                    {e.engineNote ? <span>{e.engineNote}</span> : null}
                    {e.voiceNote ? <span>{e.voiceNote}</span> : null}
                  </p>
                ) : null}
              </div>
            </div>
          ),
        )}
        {sending ? (
          <>
            <div className={styles.person}>
              <p className={styles.heardLabel}>You typed</p>
              <p className={demo.reply}>{page.sending}</p>
            </div>
            <div className={`${demo.said} ${demo.thinking}`} aria-hidden="true">
              <Mark state="thinking" />
              <span className={demo.dots}>
                <span />
                <span />
                <span />
              </span>
            </div>
          </>
        ) : null}
      </div>

      <div className={demo.composer}>
        <div
          data-offer
          onFocus={() => {
            focusInOffer.current = true;
          }}
          onBlur={(e) => {
            if (e.relatedTarget) {
              if (!e.currentTarget.contains(e.relatedTarget)) focusInOffer.current = false;
              return;
            }
            // Nowhere to go: a button removed with its card keeps the flag; a click on the background clears it.
            const left = e.target;
            requestAnimationFrame(() => {
              if (left.isConnected) focusInOffer.current = false;
            });
          }}
        >
          {page.card ? <OfferCard key={page.card.proposal.proposal_id} page={page} focusIn={focusInOffer} /> : null}
        </div>
        <p id={`${ids}-notice`} className={styles.typedNotice}>
          {typedNotice(typedBy)}
        </p>
        <form
          className={demo.inputPill}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          noValidate
        >
          <label htmlFor={`${ids}-input`} className="visually-hidden">
            Ask Sophi
          </label>
          <input
            ref={inputRef}
            id={`${ids}-input`}
            className={demo.input}
            type="text"
            value={text}
            maxLength={MAX_TYPED}
            autoComplete="off"
            placeholder="Ask Sophi about your walker"
            onChange={(e) => setText(e.target.value)}
            aria-describedby={page.sendError ? `${ids}-notice ${errorId}` : `${ids}-notice`}
          />
          <button type="submit" className={demo.sendButton} aria-label="Send" aria-disabled={sending || !text.trim() || undefined}>
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M10 15.5V4.5M5 9.5l5-5 5 5" />
            </svg>
          </button>
        </form>
        {page.sendError ? (
          <p id={errorId} className={demo.error} role="alert">
            {page.sendError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The open offer: the server's summary, what changes, a countdown and two real buttons. The countdown
 * is a timer, which screen readers don't announce on their own; the offer itself was announced once
 * when it arrived. When it closes (answered here, on the walker, or out of time) the buttons give way to
 * one line saying how, and focus moves to that line if it was on the buttons.
 */
function OfferCard({ page, focusIn }: { page: WalkerPage; focusIn: React.RefObject<boolean> }) {
  const card = page.card!;
  const p = card.proposal;
  const now = useNow(500);
  const left = secondsLeft(Date.parse(p.expires_at), now + (page.serverNow() - Date.now()));
  // The server owns expiry; at 0 the page stops offering buttons it knows the server will refuse.
  const outcome = card.outcome ?? (left === 0 ? OUT_OF_TIME : null);
  const ids = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hadFocus = useRef(false);

  // A card that replaced another while focus was on it takes focus on its heading.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (focusIn.current && (!active || active === document.body)) headingRef.current?.focus({ preventScroll: true });
  }, [focusIn]);

  // When the buttons go with focus on them, focus moves to the card's heading, which names the outcome.
  // Never away from somewhere else.
  useLayoutEffect(() => {
    if (!outcome || !hadFocus.current) return;
    hadFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus({ preventScroll: true });
  }, [outcome]);

  const busy = page.answering !== null;
  return (
    <section className={styles.offer} data-closed={outcome ? "" : undefined} aria-labelledby={`${ids}-kicker`}>
      <h3 id={`${ids}-kicker`} ref={headingRef} tabIndex={-1} className={styles.offerKicker}>
        Sophi offers
        {/* The heading names the card's state, so focus moved here reads how the offer ended. */}
        {outcome ? <span className="visually-hidden">: {outcome}</span> : null}
      </h3>
      <p id={`${ids}-summary`} className={styles.offerSummary}>
        {p.summary}
      </p>
      <dl className={styles.offerCues}>
        <dt>Now</dt>
        <dd>{cueList(p.from_cues)}</dd>
        <dt>After</dt>
        <dd>{cueList(p.cues)}</dd>
      </dl>
      {outcome ? (
        <p className={styles.offerOutcome}>
          {outcome}
        </p>
      ) : (
        <div
          className={styles.offerActions}
          data-offer-actions
          onFocus={() => {
            hadFocus.current = true;
          }}
          onBlur={(e) => {
            if (e.relatedTarget) {
              if (!e.currentTarget.contains(e.relatedTarget)) hadFocus.current = false;
              return;
            }
            // Nowhere to go: a button removed with the buttons keeps the flag; a click on the background clears it.
            const left = e.target;
            requestAnimationFrame(() => {
              if (left.isConnected) hadFocus.current = false;
            });
          }}
        >
          <button
            type="button"
            className="button button-primary"
            aria-describedby={`${ids}-summary`}
            aria-disabled={busy || undefined}
            onClick={() => void (busy ? null : page.answer("confirm"))}
          >
            {page.answering === "confirm" ? "Confirming" : "Confirm"}
          </button>
          <button
            type="button"
            className="button button-secondary"
            aria-describedby={`${ids}-summary`}
            aria-disabled={busy || undefined}
            onClick={() => void (busy ? null : page.answer("decline"))}
          >
            {page.answering === "decline" ? "Declining" : "Decline"}
          </button>
          <span className={styles.countdown} role="timer">
            Expires in {formatCountdown(left)}
          </span>
        </div>
      )}
      {!outcome ? <p className={styles.meta}>Or press Confirm on the walker.</p> : null}
      {page.answerError ? (
        <p className={styles.alertLine} role="alert">
          {page.answerError}
        </p>
      ) : null}
    </section>
  );
}
