"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import { PRESET_ORDER, PRESET_REPLIES } from "@/lib/phoneApi";
import { PRODUCT_NAME } from "@/lib/brand";
import { useReducedMotion } from "@/lib/motion";
import { SAMPLE_DESTINATION, SAMPLE_DESTINATION_SHORT, SAMPLE_THREAD, SAMPLE_WALK, type SamplePoint } from "@/lib/sampleScreens";
import { WalkerMark } from "./WalkerMark";
import phone from "./Phone.module.css";
import styles from "./Sample.module.css";

/**
 * The two sample phone screens for the stage (src/lib/sampleScreens.ts): Maya's phone with Rose's walk on a
 * map, and Rose's phone with her messages. Each is drawn as a phone in the middle of a half-laptop window
 * (full width on a real phone), for a glance during the demo, and carries one "Sample" tag in its top
 * corner. Nothing on them is live and nothing can be pressed.
 */
function SampleFrame({ who, label, children }: { who: string; label: string; children: React.ReactNode }) {
  return (
    <div className={`${phone.root} ${styles.stage}`}>
      <div className={styles.device} role="region" aria-label={label}>
        <header className={styles.bar}>
          <span className={phone.brand}>
            <WalkerMark size={28} />
            {PRODUCT_NAME}
          </span>
          <span className={styles.who}>{who}</span>
          <span className={`${phone.tag} ${styles.sampleTag}`}>Sample</span>
        </header>
        <main id="main" className={styles.body}>
          {children}
        </main>
      </div>
    </div>
  );
}

export function CaretakerSample() {
  const { leftM, leftMin } = SAMPLE_WALK;
  return (
    <SampleFrame who="Maya's phone" label="Sample screen: Maya's phone, made-up data">
      <section className={styles.walk} aria-labelledby="walk-title">
        <div className={styles.walkHead}>
          <p className={styles.live}>
            <span className={styles.liveDot} aria-hidden="true" />
            Walking now
          </p>
          <h1 id="walk-title" className={styles.walkTitle}>
            Rose is on her way
          </h1>
        </div>
        <WalkMap />
        <div className={styles.eta}>
          <p className={styles.etaBig}>
            {leftMin} min <span className={styles.etaLeft}>left</span>
          </p>
          <p className={styles.etaTo}>
            {leftM} m to the {SAMPLE_DESTINATION}
          </p>
          <p className={styles.etaMeta}>Walker online · Updated just now</p>
        </div>
      </section>
    </SampleFrame>
  );
}

export function RoseSample() {
  return (
    <SampleFrame who="Rose's phone" label="Sample screen: Rose's phone, made-up data">
      <section className={styles.chat} aria-labelledby="chat-title">
        <h1 id="chat-title" className={styles.chatTitle}>
          Messages with Maya
        </h1>
        <ol className={styles.thread}>
          {SAMPLE_THREAD.map((m, i) => (
            <li key={i} className={styles.bubble} data-mine={m.from === "rose" || undefined}>
              <span className={styles.bubbleWho}>
                {m.from === "rose" ? "You" : "Maya"} · {m.at}
              </span>
              <span className={styles.bubbleText}>{m.text}</span>
              {m.from === "maya" ? (
                <span className={styles.readAloud}>
                  <SpeakerIcon />
                  Read aloud on your walker
                </span>
              ) : null}
            </li>
          ))}
        </ol>
        <div className={styles.replies}>
          <h2 className={styles.repliesTitle}>Reply to Maya</h2>
          <ul className={styles.replyList}>
            {PRESET_ORDER.map((p) => (
              <li key={p} className={styles.reply}>
                {PRESET_REPLIES[p]}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </SampleFrame>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 010 6M18.5 6.5a7.5 7.5 0 010 11" />
    </svg>
  );
}

// OpenStreetMap's own tiles, as on the app's other maps (NearbyMap): no key, light use only, with its
// attribution. Drawn at 70% over the paper so the route stands out; Sample.module.css inverts them in dark mode.
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * The sample route on a real street map, fixed in place: no dragging, zooming or keys, since nobody touches
 * it on stage. The part she has walked is a quiet grey line, the part ahead a bold green one, with her dot
 * where they meet and a pin at the Boating Center. The tiles are for the sample's fixed area, so no one's
 * position is sent. The words under the map say the same for a screen reader.
 */
function WalkMap() {
  const box = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => {};
    void import("leaflet").then(({ default: L }) => {
      if (cancelled) return;
      const map = L.map(el, {
        zoomControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        touchZoom: false,
        keyboard: false,
        // Quarter steps, so the route fills the map (Sample.module.css hides the seams this leaves between tiles).
        zoomSnap: 0.25,
        fadeAnimation: !reduce,
        zoomAnimation: false,
      });
      L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19, opacity: 0.7 }).addTo(map);
      map.attributionControl.setPrefix(false);

      const line = (pts: readonly SamplePoint[], className: string) =>
        L.polyline(pts.map(([a, b]) => [a, b] as [number, number]), { className, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(map);
      line(SAMPLE_WALK.behind, styles.routeBehind!);
      line(SAMPLE_WALK.ahead, styles.routeCasing!);
      line(SAMPLE_WALK.ahead, styles.routeAhead!);

      const pin = (at: SamplePoint, html: string, size: [number, number], anchor: [number, number]) =>
        L.marker([at[0], at[1]], {
          icon: L.divIcon({ html, className: styles.pinBox, iconSize: size, iconAnchor: anchor }),
          interactive: false,
          keyboard: false,
        }).addTo(map);
      pin(SAMPLE_WALK.start, `<span class="${styles.startDot}"></span>`, [14, 14], [7, 7]);
      pin(SAMPLE_WALK.end, `<span class="${styles.endPin}"><span class="${styles.endLabel}">${SAMPLE_DESTINATION_SHORT}</span></span>`, [0, 0], [0, 0]);
      pin(SAMPLE_WALK.at, `<span class="${styles.her}"><span class="${styles.herDot}"></span><span class="${styles.herLabel}">Rose</span></span>`, [0, 0], [0, 0]);

      const fit = () =>
        map.fitBounds(L.latLngBounds(SAMPLE_WALK.behind.concat(SAMPLE_WALK.ahead).map(([a, b]) => [a, b] as [number, number])), {
          // Room for Rose's label above her dot and the Boating Center's below its pin.
          paddingTopLeft: [48, 56],
          paddingBottomRight: [48, 76],
        });
      fit();
      const watch = new ResizeObserver(() => {
        map.invalidateSize();
        fit();
      });
      watch.observe(el);
      cleanup = () => {
        watch.disconnect();
        map.remove();
      };
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [reduce]);

  return (
    <figure className={styles.mapFigure}>
      <div ref={box} className={styles.map} aria-hidden="true" />
      <figcaption className="visually-hidden">
        Sample map by Lake Merritt, Oakland: Rose&apos;s route to the {SAMPLE_DESTINATION}, with the part she has walked and her
        position, {SAMPLE_WALK.leftM} metres before the end.
      </figcaption>
    </figure>
  );
}
