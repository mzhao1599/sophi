"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { caregiverConsentLine, type CircleInvite, type OwnerPhonesResponse } from "@walker/contracts";
import { PhoneApiError, type OwnerPhonesApi, type PhoneRole } from "@/lib/phoneApi";
import { ownerError, phoneRoleWord } from "@/lib/phoneView";
import { formatCode } from "@/lib/walkerView";
import walker from "./Walker.module.css";
import styles from "./PhonesPanel.module.css";

const LIST_POLL_MS = 3_000;

/**
 * "Phones" on the owner's page: add a phone with a one-time code (her own phone, or a caretaker's), approve a
 * caretaker who typed a code (only with the consent line ticked: the lean stand-in for her own Confirm on the
 * walker), and remove a phone. Codes show here only.
 */
export function PhonesPanel({ api, deviceId }: { api: OwnerPhonesApi; deviceId: string }) {
  const [list, setList] = useState<OwnerPhonesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setList(await api.list(deviceId));
    } catch (e) {
      if (e instanceof PhoneApiError && e.code === "not_offered") setError(ownerError("not_offered"));
    } finally {
      busy.current = false;
    }
  }, [api, deviceId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, LIST_POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function act(what: () => Promise<unknown>, done: string) {
    setError(null);
    try {
      await what();
      setStatus(done);
      await load();
      return true;
    } catch (e) {
      setError(ownerError(e instanceof PhoneApiError ? e.code : "network"));
      return false;
    }
  }

  const herName = list?.members.find((m) => m.role === "walker_user")?.name ?? null;

  return (
    <section className={`${walker.card} ${styles.panel}`} aria-labelledby="phones-heading">
      <h2 id="phones-heading" className={walker.cardTitle}>
        Phones
      </h2>
      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
      {list === null && !error ? <p className={walker.empty}>Loading the phones.</p> : null}
      {list ? (
        <>
          {list.joins.map((j) => (
            <Waiting
              key={j.member_id}
              line={caregiverConsentLine(j.name, herName)}
              name={j.name}
              approve={() => act(() => api.approve(deviceId, j.member_id), `${j.name}'s phone is in.`)}
              decline={() => act(() => api.remove(deviceId, j.member_id), `${j.name}'s phone was declined.`)}
            />
          ))}
          {list.members.length === 0 ? (
            <p className={walker.empty}>No phones yet.</p>
          ) : (
            <ul className={walker.rows}>
              {list.members.map((m) => (
                <li key={m.member_id} className={walker.row}>
                  <span className={walker.rowTop}>
                    <span className={walker.rowName}>{m.name}</span>
                    <RemoveButton name={m.name} remove={() => act(() => api.remove(deviceId, m.member_id), `${m.name}'s phone was removed.`)} />
                  </span>
                  <span className={walker.rowWords}>{phoneRoleWord(m.role === "family" ? "caregiver" : m.role)}</span>
                </li>
              ))}
            </ul>
          )}
          {list.invites.map((i) => (
            <Code key={i.invite_id} invite={i} />
          ))}
          <AddPhone add={(name, role) => act(() => api.addPhone(deviceId, name, role), `A code for ${name} is ready.`)} />
        </>
      ) : null}
      {error ? (
        <p className={walker.alertLine} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function Code({ invite }: { invite: CircleInvite }) {
  const until = new Date(invite.expires_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <div role="group" aria-label={`Code for ${invite.name}: ${invite.code.split("").join(" ")}`}>
      <p className={walker.codeLabel}>
        Code for {invite.name} ({phoneRoleWord(invite.role === "family" ? "caregiver" : invite.role).toLowerCase()})
      </p>
      <p className={styles.code} aria-hidden="true">
        {formatCode(invite.code)}
      </p>
      <p className={walker.meta}>Type it in the Sophi app on that phone (/app). Works once, until {until}.</p>
    </div>
  );
}

function Waiting({ name, line, approve, decline }: { name: string; line: string; approve(): Promise<boolean>; decline(): Promise<boolean> }) {
  const [agreed, setAgreed] = useState(false);
  const [hint, setHint] = useState(false);
  const id = `consent-${name}`;
  return (
    <div className={styles.waiting}>
      <p className={walker.rowName}>{name} is waiting to join, as a caretaker.</p>
      <label className={styles.consent} htmlFor={id}>
        <input id={id} type="checkbox" checked={agreed} onChange={(e) => (setAgreed(e.target.checked), setHint(false))} />
        <span>{line}</span>
      </label>
      {hint ? (
        <p className={walker.alertLine} role="alert">
          Ask her first, then tick the line above.
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="button"
          className="button button-primary"
          aria-disabled={!agreed || undefined}
          onClick={() => (agreed ? void approve() : setHint(true))}
        >
          Approve {name}
        </button>
        <button type="button" className="button button-secondary" onClick={() => void decline()}>
          Decline
        </button>
      </div>
    </div>
  );
}

function RemoveButton({ name, remove }: { name: string; remove(): Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="button-text" onClick={() => setAsking(true)}>
        Remove<span className="visually-hidden"> {name}&apos;s phone</span>
      </button>
    );
  }
  return (
    <span className={styles.actions}>
      <span>Remove {name}&apos;s phone and its messages?</span>
      <button type="button" className="button button-secondary" autoFocus onClick={() => setAsking(false)}>
        Keep it
      </button>
      <button type="button" className="button-text button-danger" onClick={() => void remove()}>
        Remove
      </button>
    </span>
  );
}

function AddPhone({ add }: { add(name: string, role: PhoneRole): Promise<boolean> }) {
  const [role, setRole] = useState<PhoneRole>("walker_user");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n || [...n].length > 12) {
      setProblem("A name of 1 to 12 characters.");
      return;
    }
    setProblem(null);
    setSending(true);
    if (await add(n, role)) setName("");
    setSending(false);
  }

  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate aria-labelledby="add-phone-heading">
      <h3 id="add-phone-heading" className={walker.cardTitle}>
        Add a phone
      </h3>
      <fieldset className={styles.choices}>
        <legend className="visually-hidden">Whose phone</legend>
        <label className={styles.choice}>
          <input type="radio" name="phone-role" checked={role === "walker_user"} onChange={() => setRole("walker_user")} />
          The walker user&apos;s own phone
        </label>
        <label className={styles.choice}>
          <input type="radio" name="phone-role" checked={role === "caregiver"} onChange={() => setRole("caregiver")} />
          A caretaker&apos;s phone
        </label>
      </fieldset>
      <label className={styles.field}>
        Their name
        <input
          value={name}
          autoComplete="off"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? "add-phone-problem" : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {problem ? (
        <p id="add-phone-problem" className={walker.alertLine} role="alert">
          {problem}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="submit" className="button button-primary" aria-disabled={sending || undefined}>
          {sending ? "Getting a code" : "Get a code"}
        </button>
      </div>
    </form>
  );
}
