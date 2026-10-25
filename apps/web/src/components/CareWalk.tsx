"use client";

import type { NavigationPhase, PhoneWalkerView } from "@walker/contracts";
import { RouteMap } from "./RouteMap";
import phone from "./Phone.module.css";
import styles from "./CareWalk.module.css";

/**
 * Where she is, on a caretaker's phone (added 2026-10-25): the walking route she's on, drawn from what her
 * walker shares while she has location sharing on (`walker.route`), or her position alone. The first thing on
 * Maya's Walker screen, read at a glance: who, where to, how long, and the route on a map. Nothing here when she
 * doesn't share; the Walker's location card below says so. A simulated position says so once.
 */

const PHASE_WORD: Record<NavigationPhase, string> = {
  guiding: "Walking now",
  rerouting: "Finding the way again",
  off_route: "Off the route",
  no_position: "Waiting for a position",
  arrived: "Arrived",
};

/** The destination's label on the map: the part before the first comma, at most 28 characters. */
export function shortPlace(name: string): string {
  const first = name.split(",")[0]!.trim();
  return first.length <= 28 ? first : `${first.slice(0, 27).trimEnd()}…`;
}

export function updatedWords(ageSeconds: number): string {
  return ageSeconds < 5 ? "Updated just now" : `Updated ${ageSeconds} s ago`;
}

export function timeLeftWords(minutes: number): string {
  return minutes < 1 ? "Less than a minute" : `${minutes} min`;
}

export function CareWalk({ walker, herName }: { walker: PhoneWalkerView; herName: string }) {
  const route = walker.route ?? null;
  const fix = walker.location ?? null;
  if (!fix && !route) return null;
  const at = fix ? ([fix.latitude, fix.longitude] as const) : route!.ahead[0]!;
  const simulated = route?.simulated || fix?.simulated;
  const age = route?.age_seconds ?? fix!.age_seconds;
  const arrived = route?.phase === "arrived";

  return (
    <section className={styles.walk} aria-labelledby="walk-title">
      <div className={styles.head}>
        <p className={styles.live} data-phase={route?.phase ?? "position"}>
          <span className={styles.liveDot} aria-hidden="true" />
          {route ? PHASE_WORD[route.phase] : "Location shared"}
        </p>
        <div className={phone.titleRow}>
          <h2 id="walk-title" className={styles.title}>
            {route ? (arrived ? `${herName} has arrived` : `${herName} is on the way`) : `Where ${herName} is`}
          </h2>
          {simulated ? <span className={phone.tag}>Simulated position</span> : null}
        </div>
      </div>
      <RouteMap
        className={styles.map}
        at={at}
        herName={herName}
        ahead={route && !arrived ? route.ahead : []}
        end={route ? { at: route.destination_point, label: shortPlace(route.destination) } : undefined}
        caption={
          route
            ? `Map: ${herName}'s route to ${route.destination}, ${route.remaining_m} metres to go${simulated ? ", on a simulated position" : ""}.`
            : `Map: ${herName}'s position${simulated ? ", simulated" : ""}.`
        }
      />
      <div className={styles.eta}>
        {route && !arrived ? (
          <>
            <p className={styles.etaBig}>
              {timeLeftWords(route.remaining_min)} <span className={styles.etaLeft}>left</span>
            </p>
            <p className={styles.etaTo}>
              {route.remaining_m} m to {route.destination}
            </p>
          </>
        ) : route ? (
          <p className={styles.etaTo}>Near {route.destination}</p>
        ) : null}
        <p className={styles.etaMeta}>
          {updatedWords(age)}. Map from OpenStreetMap, which sees the area shown.
        </p>
      </div>
    </section>
  );
}
