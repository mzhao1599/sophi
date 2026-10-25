"use client";

import { useEffect, useRef } from "react";
import type { Map as LeafletMap, Marker, Polyline } from "leaflet";
import "leaflet/dist/leaflet.css";
import { useReducedMotion } from "@/lib/motion";
import styles from "./RouteMap.module.css";

/** [latitude, longitude]. */
export type MapPoint = readonly [number, number];

// OpenStreetMap's own tiles, as on the app's other maps (NearbyMap): no key, light use only, with its
// attribution. Drawn at 70% over the paper so the route stands out; RouteMap.module.css inverts them in dark mode.
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export interface RouteMapProps {
  /** Her position: a green dot with her name above it. */
  at: MapPoint;
  herName: string;
  /** The route ahead of her, from her position to the end (bold green); empty for a position alone. */
  ahead?: readonly MapPoint[];
  /** The part already walked (grey dots), when known. The live route has only the part ahead. */
  behind?: readonly MapPoint[];
  /** Where she started (a small ring), when known. */
  start?: MapPoint;
  /** The destination: an ink pin with a short label under it. */
  end?: { at: MapPoint; label: string };
  /** What the map shows, in words, for a screen reader (the map itself is hidden from one). */
  caption: string;
  className?: string;
}

/**
 * A route on a real street map, fixed in place: no dragging, zooming or keys, since it's read at a glance. Used
 * by Maya's phone for the route Rose shares (MayaPhone) and by the stage sample (SampleScreens). Made once, then
 * updated in place as new positions arrive, so it doesn't flash; it refits only when the destination changes or
 * she leaves the view. Labels are built as DOM text, never HTML, because place names and people's names come
 * from data. The tiles are for the area shown, so OpenStreetMap's tile server sees which area that is.
 */
export function RouteMap({ at, herName, ahead = [], behind = [], start, end, caption, className }: RouteMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const map = useRef<{ L: typeof import("leaflet"); map: LeafletMap; layers: (Polyline | Marker)[]; fitted: string } | null>(null);
  const props = useRef({ at, herName, ahead, behind, start, end });
  props.current = { at, herName, ahead, behind, start, end };

  // Draws (or redraws) the layers from the latest props.
  const draw = () => {
    const m = map.current;
    if (!m) return;
    const { L } = m;
    const p = props.current;
    for (const layer of m.layers) layer.remove();
    m.layers = [];
    const ll = (pts: readonly MapPoint[]) => pts.map(([a, b]) => [a, b] as [number, number]);
    const line = (pts: readonly MapPoint[], cls: string) => {
      if (pts.length < 2) return;
      m.layers.push(L.polyline(ll(pts), { className: cls, interactive: false, lineCap: "round", lineJoin: "round" }).addTo(m.map));
    };
    line(p.behind, styles.routeBehind!);
    line(p.ahead, styles.routeCasing!);
    line(p.ahead, styles.routeAhead!);

    const pin = (point: MapPoint, el: HTMLElement, size: [number, number], anchor: [number, number]) =>
      m.layers.push(
        L.marker([point[0], point[1]], { icon: L.divIcon({ html: el, className: styles.pinBox, iconSize: size, iconAnchor: anchor }), interactive: false, keyboard: false }).addTo(m.map),
      );
    const span = (cls: string, text?: string) => {
      const s = document.createElement("span");
      s.className = cls;
      if (text !== undefined) s.textContent = text;
      return s;
    };
    if (p.start) pin(p.start, span(styles.startDot!), [14, 14], [7, 7]);
    if (p.end) {
      const e = span(styles.endPin!);
      e.append(span(styles.endLabel!, p.end.label));
      pin(p.end.at, e, [0, 0], [0, 0]);
    }
    const her = span(styles.her!);
    her.append(span(styles.herDot!), span(styles.herLabel!, p.herName));
    pin(p.at, her, [0, 0], [0, 0]);

    // Refit when the destination changes, or when she's walked out of the view.
    const key = p.end ? `${p.end.at[0]},${p.end.at[1]}` : "here";
    const all = ll([...p.behind, ...p.ahead, p.at, ...(p.end ? [p.end.at] : [])]);
    const inView = m.map.getBounds().pad(-0.1).contains([p.at[0], p.at[1]]);
    if (key !== m.fitted || !inView) {
      m.fitted = key;
      if (all.length > 1) m.map.fitBounds(L.latLngBounds(all), { paddingTopLeft: [84, 56], paddingBottomRight: [84, 76], maxZoom: 17 });
      else m.map.setView(all[0]!, 16);
    }
  };

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => {};
    void import("leaflet").then((mod) => {
      if (cancelled) return;
      const L = mod.default;
      const created = L.map(el, {
        zoomControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        touchZoom: false,
        keyboard: false,
        zoomSnap: 0.25,
        fadeAnimation: !reduce,
        zoomAnimation: false,
      });
      L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19, opacity: 0.7 }).addTo(created);
      created.attributionControl.setPrefix(false);
      // A first view, so getBounds works before the first fit.
      created.setView([props.current.at[0], props.current.at[1]], 16);
      map.current = { L, map: created, layers: [], fitted: "" };
      draw();
      const watch = new ResizeObserver(() => {
        created.invalidateSize();
        if (map.current) map.current.fitted = "";
        draw();
      });
      watch.observe(el);
      cleanup = () => {
        watch.disconnect();
        created.remove();
        map.current = null;
      };
    });
    return () => {
      cancelled = true;
      cleanup();
    };
    // draw reads the latest props through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce]);

  // New data: redraw in place.
  const dataKey = JSON.stringify([at, herName, ahead, behind, start, end]);
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey]);

  return (
    <figure className={`${styles.figure} ${className ?? ""}`}>
      <div ref={box} className={styles.map} aria-hidden="true" />
      <figcaption className="visually-hidden">{caption}</figcaption>
    </figure>
  );
}
