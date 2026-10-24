import type { ReactNode } from "react";
import {
  SAMPLE_CARETAKERS,
  SAMPLE_GROUPS,
  SAMPLE_LINE,
  SAMPLE_PLACES,
  SAMPLE_WALKERS,
  type SamplePerson,
} from "@/lib/nearbySample";
import type { PhoneRole } from "@/lib/phoneApi";
import styles from "./Phone.module.css";

/**
 * "People nearby" (her phone) and "Nearby" (the caretaker's): the same made-up sample, read only, with a
 * dashed "Sample" tag in the heading and SAMPLE_LINE under it. Nothing here reads or sends a location.
 */
export function NearbySample({ role, heading, headingId }: { role: PhoneRole; heading: ReactNode; headingId: string }) {
  const simple = role === "walker_user";
  return (
    <section className={`${styles.nearby} ${simple ? styles.simple : ""}`} aria-labelledby={headingId}>
      <div className={styles.screen}>
        <h1 id={headingId} tabIndex={-1} className={styles.title}>
          {heading} <span className={styles.tag}>Sample</span>
        </h1>
        <p className={simple ? styles.bigNote : styles.lead}>{SAMPLE_LINE}</p>
      </div>
      {simple ? null : <People title="Caretakers nearby" people={SAMPLE_CARETAKERS} />}
      <People title="People who walk nearby" people={SAMPLE_WALKERS} />
      <section className={styles.section} aria-label="Walking groups">
        <h2 className={styles.sectionTitle}>Walking groups</h2>
        <ul className={styles.people}>
          {SAMPLE_GROUPS.map((g) => (
            <li key={g.name} className={styles.person}>
              <span className={styles.personName}>{g.name}</span>
              <span>
                {g.where}. {g.when}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className={styles.section} aria-label="Step-free places">
        <h2 className={styles.sectionTitle}>Step-free places</h2>
        <ul className={styles.people}>
          {SAMPLE_PLACES.map((p) => (
            <li key={p.name} className={styles.person}>
              <span className={styles.personName}>
                <span>{p.name}</span>
                <span className={styles.distance}>{p.distance}</span>
              </span>
              <span>{p.access}</span>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}

function People({ title, people }: { title: string; people: readonly SamplePerson[] }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <ul className={styles.people}>
        {people.map((p) => (
          <li key={p.name} className={styles.person}>
            <span className={styles.personName}>
              <span>{p.name}</span>
              <span className={styles.distance}>{p.distance}</span>
            </span>
            <span>{p.about}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
