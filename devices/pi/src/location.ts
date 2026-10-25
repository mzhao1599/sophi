import { cleanName, defaultMapServices, getMapJson, type MapServices } from "./navigation/osm";

/** One user-initiated reverse lookup. Coordinates and the response stay in Pi memory only. */
type ReverseResult = {
  name?: unknown;
  category?: unknown;
  lat?: unknown;
  lon?: unknown;
  address?: Record<string, unknown>;
};

const CACHE_MS = 5 * 60_000;
/** Per set of map services, so a test's (or the simulator's) answers never mix with the real ones. */
const caches = new WeakMap<MapServices, Map<string, { at: number; text: string }>>();

const spoken = (value: unknown) => cleanName(value);

function metres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radians = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * radians) / 2) ** 2 +
    Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(((lon2 - lon1) * radians) / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(a));
}

function line(result: ReverseResult, latitude: number, longitude: number, simulated: boolean): string {
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
  // A simulated position says so every time (the demo never passes it off as hers).
  const gps = simulated ? "simulated GPS" : "GPS";
  if (distance > 200) return `I have a ${simulated ? "simulated GPS position" : "GPS fix"}, but the map does not show a reliable nearby address.`;
  const nearby = distance <= 100;
  const isVenue = ["amenity", "tourism", "leisure", "shop", "office", "historic"].includes(String(result.category));
  const venue = nearby && isVenue && place !== street ? place : null;
  const area = [streetLine, city, state].filter(Boolean).join(", ");
  if (venue && area) return `Your ${gps} puts you near ${venue}, around ${area}.`;
  if (venue) return `Your ${gps} puts you near ${venue}.`;
  if (area) return `Your ${gps} puts you near ${area}.`;
  return `I have a ${simulated ? "simulated GPS position" : "GPS fix"}, but the map could not identify an address nearby.`;
}

/**
 * The public Nominatim endpoint is for a single prototype; set WALKER_GEOCODER_URL to switch provider. It shares
 * the Pi's one Nominatim limiter with the place search (src/navigation/osm.ts).
 */
export async function describeGpsLocation(
  latitude: number,
  longitude: number,
  signal: AbortSignal,
  options: { services?: MapServices; simulated?: boolean } = {},
): Promise<string> {
  if (signal.aborted) throw signal.reason;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Invalid GPS coordinates.");
  }
  const services = options.services ?? defaultMapServices();
  const simulated = options.simulated === true;
  const now = services.clock.monotonic();
  let cache = caches.get(services);
  if (!cache) caches.set(services, (cache = new Map()));
  const key = `${services.reverseUrl}:${simulated}:${latitude.toFixed(4)},${longitude.toFixed(4)}`;
  const prior = cache.get(key);
  if (prior && now - prior.at < CACHE_MS) return prior.text;
  const url = new URL(services.reverseUrl);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("lat", String(latitude));
  url.searchParams.set("lon", String(longitude));
  const data = (await getMapJson(services, url, { nominatim: true, signal })) as ReverseResult;
  const text = line(data && typeof data === "object" ? data : {}, latitude, longitude, simulated);
  if (cache.size >= 16) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, text });
  return text;
}
