import { CancelledError, systemClock, withDeadline, type Clock } from "../clock";
import { MAP_REQUEST_MS, MAP_RESPONSE_MAX_BYTES, NOMINATIM_GAP_MS } from "../constants";

/**
 * The map services the Pi calls itself, over HTTPS: Nominatim (finding a place, and the "Where am I?" address)
 * and OpenStreetMap's walking router. Her coordinates go only to these providers, straight from the Pi; the
 * cloud and the model never see them (docs/subsystems/navigation.md, "Privacy").
 *
 * Everything here is injectable, so tests and `walker simulate` answer from recorded responses and never touch
 * the internet: the `fetch`, the base URLs and the clock. The public services are for a single prototype under
 * their usage policies: an identified user agent and at most one Nominatim request a second, shared by every
 * caller on this Pi.
 */

export const OSM_USER_AGENT = "SophiWalker-CalHacks26/0.1 (https://github.com/mzhao1599/sophi)";
export const DEFAULT_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
export const DEFAULT_PLACES_URL = "https://nominatim.openstreetmap.org/search";
/** OSRM's foot profile; a route request appends `/{lon},{lat};{lon},{lat}`. */
export const DEFAULT_ROUTER_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/foot";

export type MapFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** At most one Nominatim request every NOMINATIM_GAP_MS, in the order they asked. */
export class NominatimLimiter {
  private nextAt = -Infinity;

  constructor(private readonly clock: Clock) {}

  async take(signal: AbortSignal): Promise<void> {
    const now = this.clock.monotonic();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = now + wait + NOMINATIM_GAP_MS;
    if (!wait) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        cancel();
        reject(signal.reason ?? new CancelledError("Map request cancelled."));
      };
      const cancel = this.clock.setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, wait);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}

export interface MapServices {
  clock: Clock;
  reverseUrl: string;
  placesUrl: string;
  routerUrl: string;
  fetch: MapFetch;
  /** The `fetch` is injected (tests, the simulator's recorded responses): the HTTPS-only rule is for real requests. */
  injected: boolean;
  limiter: NominatimLimiter;
}

/** The real services, from WALKER_GEOCODER_URL, WALKER_PLACES_URL and WALKER_ROUTER_URL (each a Nominatim- or OSRM-compatible HTTPS URL). */
export function mapServicesFromEnv(env: NodeJS.ProcessEnv, clock: Clock = systemClock): MapServices {
  return {
    clock,
    reverseUrl: env.WALKER_GEOCODER_URL || DEFAULT_REVERSE_URL,
    placesUrl: env.WALKER_PLACES_URL || DEFAULT_PLACES_URL,
    routerUrl: (env.WALKER_ROUTER_URL || DEFAULT_ROUTER_URL).replace(/\/+$/, ""),
    fetch: (url, init) => fetch(url, init),
    injected: false,
    limiter: new NominatimLimiter(clock),
  };
}

let shared: MapServices | null = null;

/** One set of real services per process, so every caller shares the one Nominatim limiter. */
export function defaultMapServices(): MapServices {
  shared ??= mapServicesFromEnv(process.env);
  return shared;
}

/** Map services answered by `fetch` (tests, the simulator): same URLs and limiter rules, no HTTPS check. */
export function injectedMapServices(clock: Clock, mapFetch: MapFetch): MapServices {
  return { ...mapServicesFromEnv({}, clock), fetch: mapFetch, injected: true };
}

/**
 * One GET with the project's user agent, a MAP_REQUEST_MS deadline and a MAP_RESPONSE_MAX_BYTES cap, parsed
 * as JSON. Nominatim requests wait their turn on the shared limiter first. Throws on any failure: a caller
 * never guesses a place or a route.
 */
export async function getMapJson(services: MapServices, url: URL, options: { nominatim: boolean; signal: AbortSignal }): Promise<unknown> {
  if (!services.injected && (url.protocol !== "https:" || url.username || url.password)) throw new Error("Map services must use HTTPS.");
  if (options.signal.aborted) throw options.signal.reason;
  if (options.nominatim) await services.limiter.take(options.signal);
  const body = await withDeadline(
    services.clock,
    MAP_REQUEST_MS,
    async (signal) => {
      const response = await services.fetch(url, {
        headers: { "user-agent": OSM_USER_AGENT, "accept-language": "en", accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new Error(`Map service HTTP ${response.status}.`);
      return readCapped(response, MAP_RESPONSE_MAX_BYTES);
    },
    options.signal,
  );
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error("Map service answered something other than JSON.");
  }
}

/** Reads at most `limit` bytes of the body; a bigger one is cancelled and refused. */
async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      throw new Error("Map response too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A name fit to say aloud: no control characters or markup, one line, at most `max` characters; else null. */
export function cleanName(value: unknown, max = 100): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\p{C}<>]/gu, " ").replace(/\s+/g, " ").trim();
  return clean && clean.length <= max ? clean : null;
}
