import { ShowCardSchema, type CapabilityManifest, type ShowCard, type ShowView, type WalkerIncomingMessage } from "@walker/contracts";
import type { PlaceReading } from "./location";
import type { WeatherReading } from "./weather";

/**
 * The walker's half of `show_on_screen` (docs/subsystems/show-on-screen.md): which views it can fill now, and
 * each view's card, built only from the Pi's own data. The model picks a view's name and nothing else, so no
 * word on the card comes from a model. Each builder returns the card (or none) and the short result text the
 * model gets back. The result never carries a caretaker message's words or any coordinates.
 */

/** What the walker has right now, for the turn request's `screen.views`. */
export function showViews(has: { gps: boolean; sensors: boolean; message: boolean }): ShowView[] {
  return [...(has.gps ? (["weather", "location"] as const) : []), ...(has.sensors ? (["sensors"] as const) : []), ...(has.message ? (["message"] as const) : []), "parts"];
}

/** A card to draw and the result text for the model, or no card and the text saying why. */
export type ShowOutcome = { card: ShowCard; text: string } | { card: null; text: string };

export const NOTHING_SHOWN = "Nothing was shown on the screen.";

export function notShown(why: string): ShowOutcome {
  return { card: null, text: `${NOTHING_SHOWN} ${why}` };
}

/** Every card is checked against the contract before it can reach the screen; one that fails shows nothing. */
function checked(card: ShowCard, text: string): ShowOutcome {
  return ShowCardSchema.safeParse(card).success ? { card, text } : notShown("The walker couldn't fill that card.");
}

/** Distances on the screen are rounded to 10 mm, as the obstacle screen rounds them. */
export function roundMm(mm: number): number {
  return Math.round(mm / 10) * 10;
}

export function weatherShow(reading: WeatherReading, simulated: boolean): ShowOutcome {
  const card: ShowCard = { view: "weather", temperature_f: reading.temperature_f, conditions: reading.conditions, wind_mph: reading.wind_mph, simulated };
  return checked(card, `Showing the weather on the screen: ${reading.text}`);
}

export function locationShow(reading: PlaceReading, simulated: boolean): ShowOutcome {
  if (!reading.place) return notShown(reading.text);
  return checked({ view: "location", place: reading.place, simulated }, `Showing the nearest address on the screen: ${reading.text}`);
}

/** One zone as the walker knows it: its latest reading, and whether that reading still counts (ZONE_VALIDITY_MS). */
export interface ShowZone {
  zone: string;
  mm: number | null;
  quality: "valid" | "invalid";
  /** Under ZONE_VALIDITY_MS old, from a module that isn't unavailable. */
  fresh: boolean;
  simulated: boolean;
}

/** Every zone, measured only when valid and fresh; anything else is unknown, never clear. At most 16. */
export function sensorsCard(zones: readonly ShowZone[]): Extract<ShowCard, { view: "sensors" }> | null {
  if (zones.length === 0) return null;
  return {
    view: "sensors",
    zones: zones.slice(0, 16).map((z) => ({
      zone: z.zone,
      distance: z.fresh && z.quality === "valid" && z.mm !== null ? { status: "measured" as const, mm: roundMm(z.mm) } : { status: "unknown" as const },
      simulated: z.simulated,
    })),
  };
}

export function sensorsShow(zones: readonly ShowZone[]): ShowOutcome {
  const card = sensorsCard(zones);
  if (!card) return notShown("The obstacle sensors haven't reported any zone yet.");
  const words = card.zones.map((z) => `${z.zone.replace(/_/g, " ")} ${z.distance.status === "measured" ? `${Math.round(z.distance.mm / 10)} centimetres` : "unknown"}`);
  return checked(card, `Showing the obstacle sensors on the screen, kept current while it is up. Right now: ${words.join(", ")}.`);
}

/** Her newest message. The result names the sender only: the words stay on the walker and its screen. */
export function messageShow(message: WalkerIncomingMessage | null): ShowOutcome {
  if (!message) return notShown("The walker holds no message from a caretaker.");
  return checked({ view: "message", message_id: message.message_id, from_name: message.from_name, text: message.text }, `Showing the newest message, from ${message.from_name}, on the screen.`);
}

/** The capability manifest's parts (the first 16), each with its own health and `simulated` flag. */
export function partsShow(manifest: CapabilityManifest): ShowOutcome {
  const parts = manifest.modules.slice(0, 16).map((m) => ({ module_id: m.module_id, health: m.health, simulated: m.simulated }));
  if (parts.length === 0) return notShown("The walker lists no parts.");
  const notOk = parts.filter((p) => p.health !== "ok");
  const simulated = parts.filter((p) => p.simulated).length;
  const health = notOk.length === 0 ? "all ok" : `${notOk.length} not ok (${notOk.map((p) => `${p.module_id} ${p.health}`).join(", ")})`;
  return checked({ view: "parts", parts }, `Showing the walker's parts on the screen: ${parts.length} parts, ${health}, ${simulated} simulated.`);
}
