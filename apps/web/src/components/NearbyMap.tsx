"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import { SAMPLE_AREA, type SamplePoint } from "@/lib/nearbySample";
import { useReducedMotion } from "@/lib/motion";
import styles from "./Phone.module.css";

export type PinKind = "person" | "group" | "place";

export interface MapPin {
  /** The number on the pin, the same as on its card in the list. */
  n: number;
  kind: PinKind;
  name: string;
  detail: string;
  at: SamplePoint;
}

// OpenStreetMap's own tiles: no key, light use only, with its attribution (tile usage policy:
// https://operations.osmfoundation.org/policies/tiles/). Dark mode inverts them in CSS.
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** The ringed point the map is drawn around: the sample's start, or (help) her walker's shared GPS fix. */
export interface MapCenter {
  at: SamplePoint;
  title: string;
  body: string;
}

const SAMPLE_START: MapCenter = { at: SAMPLE_AREA.start, title: "Starting point", body: SAMPLE_AREA.startLabel };

/**
 * A real street map with a ringed centre point and a numbered pin for each sample card. It only adds a
 * picture: every pin's name and description are also in the text beside it, which is the path for a screen
 * reader. For the sample, the tiles come from OpenStreetMap's servers for SAMPLE_AREA, a fixed place, so no
 * position of the phone or the walker is sent. With `center` set to her walker's shared GPS fix (a caretaker's
 * help card, only while she shares her location), the tiles fetched are for her area, so OpenStreetMap's tile
 * server sees which area is shown; the caption says so. One-finger drags scroll the page on a touch screen;
 * the + and − buttons zoom.
 */
export function NearbyMap({ pins, label, center = SAMPLE_START }: { pins: readonly MapPin[]; label: string; center?: MapCenter }) {
  const box = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => {};
    void import("leaflet").then(({ default: L }) => {
      if (cancelled) return;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      const map = L.map(el, {
        scrollWheelZoom: false,
        // Quarter steps, so the pins fill the map instead of jumping out a whole zoom level.
        zoomSnap: 0.25,
        dragging: !coarse,
        zoomAnimation: !reduce,
        fadeAnimation: !reduce,
        markerZoomAnimation: !reduce,
      });
      L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);

      const popup = (title: string, body: string) => {
        const div = document.createElement("div");
        const strong = document.createElement("strong");
        strong.textContent = title;
        div.append(strong, document.createElement("br"), body);
        return div;
      };
      const marker = (at: SamplePoint, html: string, title: string, body: string) => {
        const m = L.marker([at[0], at[1]], {
          icon: L.divIcon({ html, className: styles.pinBox, iconSize: [36, 36], iconAnchor: [18, 18] }),
          title,
          keyboard: true,
        }).bindPopup(popup(title, body));
        // The pin's element exists only once the map is ready, so label it when it is added.
        m.on("add", () => m.getElement()?.setAttribute("aria-label", `${title}. ${body}`));
        m.addTo(map);
      };

      marker(center.at, `<span class="${styles.startPin}"></span>`, center.title, center.body);
      for (const p of pins) {
        marker(p.at, `<span class="${styles.pin}" data-kind="${p.kind}">${p.n}</span>`, `${p.n}. ${p.name}`, p.detail);
      }
      if (pins.length === 0) map.setView([center.at[0], center.at[1]], 16);
      else
        map.fitBounds(L.latLngBounds([center.at, ...pins.map((p) => p.at)].map(([a, b]) => [a, b] as [number, number])), {
          padding: [28, 28],
        });

      cleanup = () => map.remove();
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [pins, reduce, center.at[0], center.at[1], center.title, center.body]);

  return <div ref={box} className={styles.map} role="region" aria-label={label} />;
}
