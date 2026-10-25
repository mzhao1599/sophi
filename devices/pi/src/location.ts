/** One user-initiated reverse lookup. Coordinates and the response stay in Pi memory only. */
type ReverseResult = {
  name?: unknown;
  category?: unknown;
  lat?: unknown;
  lon?: unknown;
  address?: Record<string, unknown>;
};

const DEFAULT_URL = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "SophiWalker-CalHacks26/0.1 (https://github.com/mzhao1599/sophi)";
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; reading: PlaceReading }>();

/** The nearest address: the sentence `get_location` says, and the cleaned address a `location` card shows (null when there is no reliable one). */
export interface PlaceReading {
  text: string;
  place: string | null;
}

/** A `location` card's line holds at most this many characters (ShowCardSchema). */
const PLACE_MAX = 120;
let nextRequestAt = 0;

function spoken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\p{C}<>]/gu, " ").replace(/\s+/g, " ").trim();
  return clean && clean.length <= 100 ? clean : null;
}

function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * radians) / 2) ** 2 +
    Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(((lon2 - lon1) * radians) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(a));
}

function line(result: ReverseResult, latitude: number, longitude: number): PlaceReading {
  const address = result.address ?? {};
  const street = spoken(address.road ?? address.pedestrian ?? address.footway);
  const number = spoken(address.house_number);
  const city = spoken(address.city ?? address.town ?? address.village ?? address.hamlet);
  const state = spoken(address.state);
  const streetLine = street ? [number, street].filter(Boolean).join(" ") : null;
  const place = spoken(result.name);
  const placeLat = Number(result.lat);
  const placeLon = Number(result.lon);
  const distance = Number.isFinite(placeLat) && Number.isFinite(placeLon) ? metres(latitude, longitude, placeLat, placeLon) : Infinity;
  if (distance > 200) return { text: "I have a GPS fix, but the map does not show a reliable nearby address.", place: null };
  const nearby = distance <= 100;
  const isVenue = ["amenity", "tourism", "leisure", "shop", "office", "historic"].includes(String(result.category));
  const venue = nearby && isVenue && place !== street ? place : null;
  const area = [streetLine, city, state].filter(Boolean).join(", ");
  // The card's line: the same words as the sentence, shortened (never invented) to fit.
  const fits = (text: string) => (text && text.length <= PLACE_MAX ? text : null);
  const card = fits(venue && area ? `${venue}, ${area}` : "") ?? fits(area) ?? fits([streetLine, city].filter(Boolean).join(", ")) ?? fits(venue ?? "");
  if (venue && area) return { text: `Your GPS puts you near ${venue}, around ${area}.`, place: card };
  if (venue) return { text: `Your GPS puts you near ${venue}.`, place: card };
  if (area) return { text: `Your GPS puts you near ${area}.`, place: card };
  return { text: "I have a GPS fix, but the map could not identify an address nearby.", place: null };
}

/** The public Nominatim endpoint is for a single prototype; configure WALKER_GEOCODER_URL to switch provider. */
export async function describeGpsLocation(latitude: number, longitude: number, signal: AbortSignal, endpoint = process.env.WALKER_GEOCODER_URL ?? DEFAULT_URL): Promise<string> {
  return (await lookUpPlace(latitude, longitude, signal, endpoint)).text;
}

export async function lookUpPlace(latitude: number, longitude: number, signal: AbortSignal, endpoint = process.env.WALKER_GEOCODER_URL ?? DEFAULT_URL): Promise<PlaceReading> {
  if (signal.aborted) throw signal.reason;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Invalid GPS coordinates.");
  }
  const key = `${endpoint}:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const prior = cache.get(key);
  if (prior && Date.now() - prior.at < CACHE_MS) return prior.reading;
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Geocoder must use HTTPS.");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  const wait = Math.max(0, nextRequestAt - Date.now());
  nextRequestAt = Date.now() + wait + 1_100; // Public endpoint limit: at most one request per second.
  if (wait) await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, wait);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT, "accept-language": "en", accept: "application/json" }, redirect: "error", signal: deadline });
  if (!response.ok) throw new Error(`Geocoder HTTP ${response.status}.`);
  const body = await response.text();
  if (body.length > 16_384) throw new Error("Geocoder response too large.");
  const data = JSON.parse(body) as ReverseResult;
  const reading = line(data, latitude, longitude);
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), reading });
  return reading;
}
