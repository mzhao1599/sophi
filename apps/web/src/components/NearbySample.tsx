import type { ReactNode } from "react";
import {
  SAMPLE_AREA,
  SAMPLE_CARETAKERS,
  SAMPLE_GROUPS,
  SAMPLE_LINE,
  SAMPLE_PLACES,
  SAMPLE_WALKERS,
  sampleDistance,
} from "@/lib/nearbySample";
import type { PhoneRole } from "@/lib/phoneApi";
import { NearbyMap, type MapPin } from "./NearbyMap";
import styles from "./Phone.module.css";

interface Card extends MapPin {
  distance: string;
}

/** Every card in the order the list shows it, numbered from 1 so each matches its pin on the map. */
function cards(simple: boolean): { caretakers: Card[]; walkers: Card[]; groups: Card[]; places: Card[]; all: Card[] } {
  let n = 0;
  const card = (kind: Card["kind"], name: string, detail: string, at: Card["at"]): Card => ({
    n: ++n,
    kind,
    name,
    detail,
    at,
    distance: sampleDistance(at),
  });
  const caretakers = simple ? [] : SAMPLE_CARETAKERS.map((p) => card("person", p.name, p.about, p.at));
  const walkers = SAMPLE_WALKERS.map((p) => card("person", p.name, p.about, p.at));
  const groups = SAMPLE_GROUPS.map((g) => card("group", g.name, `${g.where}. ${g.when}`, g.at));
  const places = SAMPLE_PLACES.map((p) => card("place", p.name, p.access, p.at));
  return { caretakers, walkers, groups, places, all: [...caretakers, ...walkers, ...groups, ...places] };
}

const SIMPLE = cards(true);
const FULL = cards(false);

/**
 * "People nearby" (her phone) and "Nearby" (the caretaker's): the same made-up sample, read only, with a
 * dashed "Sample" tag in the heading and SAMPLE_LINE under it. A real street map shows the sample's pins,
 * numbered like the cards below it. Nothing here reads or sends a location.
 */
export function NearbySample({ role, heading, headingId }: { role: PhoneRole; heading: ReactNode; headingId: string }) {
  const simple = role === "walker_user";
  const { caretakers, walkers, groups, places, all } = simple ? SIMPLE : FULL;
  return (
    <section className={`${styles.nearby} ${simple ? styles.simple : ""}`} aria-labelledby={headingId}>
      <div className={styles.screen}>
        <h1 id={headingId} tabIndex={-1} className={styles.title}>
          {heading} <span className={styles.tag}>Sample</span>
        </h1>
        <p className={simple ? styles.bigNote : styles.lead}>{SAMPLE_LINE}</p>
      </div>
      <figure className={styles.mapFigure}>
        <NearbyMap pins={all} label={`Map of ${SAMPLE_AREA.name} with the sample's numbered pins`} />
        <figcaption className={styles.mapCaption}>
          <span>{SAMPLE_AREA.name}. The numbers match the list below.</span>
          <span className={styles.legend} aria-hidden="true">
            <span><span className={styles.pin} data-kind="person" /> People</span>
            <span><span className={styles.pin} data-kind="group" /> Groups</span>
            <span><span className={styles.pin} data-kind="place" /> Places</span>
            <span><span className={styles.startPin} /> Start</span>
          </span>
        </figcaption>
      </figure>
      {simple ? null : <Cards title="Caretakers nearby" cards={caretakers} />}
      <Cards title="People who walk nearby" cards={walkers} />
      <Cards title="Walking groups" cards={groups} />
      <Cards title="Step-free places" cards={places} />
    </section>
  );
}

function Cards({ title, cards }: { title: string; cards: readonly Card[] }) {
  return (
    <section className={styles.section} aria-label={title}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      <ul className={styles.people}>
        {cards.map((c) => (
          <li key={c.n} className={styles.person}>
            <span className={styles.personName}>
              <span>
                <span className={styles.pin} data-kind={c.kind} aria-hidden="true">
                  {c.n}
                </span>{" "}
                {c.name}
              </span>
              <span className={styles.distance}>{c.distance}</span>
            </span>
            <span>{c.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
