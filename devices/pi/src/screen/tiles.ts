import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../log";

/**
 * Map tiles for the walker screen's walking directions (docs/subsystems/navigation.md, "The screen"). The page's
 * security policy allows images from its own server only (`img-src 'self'`), so the screen server answers
 * `GET /tiles/{z}/{x}/{y}.png` from a disk cache, and on a miss fetches that one tile from OpenStreetMap's tile
 * server, keeps it, and serves it. Offline, a cached tile is still served and a missing one is a 404 (the page
 * then draws the route and her dot on a plain background). `walker tiles --around <lat>,<lon>` fills the cache
 * for a demo area beforehand.
 *
 * OpenStreetMap's tile usage policy (https://operations.osmfoundation.org/policies/tiles/): an identifying user
 * agent, tiles kept locally (here until the cache's size cap), at most two connections at once, no bulk
 * downloading (warming is capped and paced at about one tile a second), and the "© OpenStreetMap contributors"
 * credit on every map (the screen draws it).
 *
 * What goes out: only the three numbers of the tile, in OpenStreetMap's URL, with the user agent below. Nothing
 * from the page's request (no header, cookie or query) is forwarded. The numbers say roughly where she is, so
 * they are never logged: logs carry counts and error kinds only.
 */

export const TILE_USER_AGENT = "SophiWalker-CalHacks26/0.1 (https://github.com/mzhao1599/sophi)";
export const TILE_UPSTREAM = "https://tile.openstreetmap.org";
export const TILE_MAX_ZOOM = 19;
/** The cache's size cap: about 20,000 tiles of the city's usual 10 KB. */
export const TILE_CACHE_MAX_BYTES = 200 * 1024 * 1024;
/** One tile larger than this is refused (they are 256x256 PNGs, usually 5 to 40 KB). */
export const TILE_MAX_BYTES = 512 * 1024;
const FETCH_TIMEOUT_MS = 6000;
/** The usage policy's "at most two connections". */
const UPSTREAM_CONNECTIONS = 2;
/** Tiles waiting for a connection beyond this many are a 404: no page can queue a bulk download through the walker. */
const MAX_WAITING = 32;
/** After the tile server couldn't be reached, the screen asks again only this much later (offline: no stalls). */
const UNREACHABLE_BACKOFF_MS = 30_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Tile {
  z: number;
  x: number;
  y: number;
}

const tileKey = (t: Tile) => `${t.z}/${t.x}/${t.y}`;

/** `/tiles/17/21023/50645.png` to its numbers, or null for anything else (a zoom over 19, a number off the map). */
export function parseTilePath(path: string): Tile | null {
  const m = /^\/tiles\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/.exec(path);
  if (!m) return null;
  const [z, x, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (z > TILE_MAX_ZOOM || x >= 2 ** z || y >= 2 ** z) return null;
  return { z, x, y };
}

export type TileResult = { status: "ok"; body: Buffer } | { status: "missing" };

/** Whether to fetch missing tiles (`fetch`), only serve cached ones (`cache`), or serve none (`off`). */
export type TileMode = "fetch" | "cache" | "off";

/**
 * Where the cache lives and whether it fetches. WALKER_TILE_DIR names the folder; otherwise the walker's state
 * folder on the Pi (WALKER_STATE_DIR, else /var/lib/steady-walker, as in run.ts), or ~/.cache/sophi-walker/tiles
 * for the simulator, so a laptop warmed once keeps its tiles across runs. WALKER_TILES=cache never fetches (an
 * offline demo with a warmed cache); WALKER_TILES=off serves none.
 */
export function readTileSettings(env: NodeJS.ProcessEnv, simulator: boolean): { dir: string; mode: TileMode } {
  const dir = env.WALKER_TILE_DIR || (simulator ? join(homedir(), ".cache", "sophi-walker", "tiles") : join(env.WALKER_STATE_DIR || "/var/lib/steady-walker", "tiles"));
  const mode: TileMode = env.WALKER_TILES === "off" ? "off" : env.WALKER_TILES === "cache" ? "cache" : "fetch";
  return { dir, mode };
}

export interface TileCacheOptions {
  dir: string;
  /** null: never fetch, serve only what is cached. */
  fetch: typeof globalThis.fetch | null;
  log: Logger;
  upstream?: string;
  maxBytes?: number;
  /** Monotonic ms, for the unreachable backoff. */
  monotonic?: () => number;
}

export type FetchOutcome = "fetched" | "cached" | "failed" | "unreachable";

export class TileCache {
  private readonly upstream: string;
  private readonly maxBytes: number;
  private readonly monotonic: () => number;
  private readonly inFlight = new Map<string, Promise<Buffer | null>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private unreachableUntil = Number.NEGATIVE_INFINITY;
  /** Every cached tile's size and when it was written, read from the folder at the first write. */
  private index: Map<string, { bytes: number; at: number }> | null = null;
  private total = 0;
  private warned = new Set<string>();

  constructor(private readonly options: TileCacheOptions) {
    this.upstream = (options.upstream ?? TILE_UPSTREAM).replace(/\/+$/, "");
    this.maxBytes = options.maxBytes ?? TILE_CACHE_MAX_BYTES;
    this.monotonic = options.monotonic ?? (() => performance.now());
  }

  private file(t: Tile): string {
    return join(this.options.dir, String(t.z), String(t.x), `${t.y}.png`);
  }

  private warnOnce(kind: string, fields: Record<string, string | number> = {}): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    this.options.log.warn("map tiles: " + kind, fields);
  }

  /** The cached tile, or null. */
  async cached(t: Tile): Promise<Buffer | null> {
    try {
      return await readFile(this.file(t));
    } catch {
      return null;
    }
  }

  /** A tile for the screen: from the cache, else fetched (when this cache fetches), else missing. */
  async get(t: Tile): Promise<TileResult> {
    const hit = await this.cached(t);
    if (hit) return { status: "ok", body: hit };
    if (!this.options.fetch || this.monotonic() < this.unreachableUntil) return { status: "missing" };
    const body = await this.fetchOnce(t);
    return body ? { status: "ok", body } : { status: "missing" };
  }

  /** For warming: fetch one tile unless it is cached. "unreachable" means the tile server didn't answer at all. */
  async warm(t: Tile): Promise<FetchOutcome> {
    if (await this.cached(t)) return "cached";
    if (!this.options.fetch) return "failed";
    const before = this.unreachableUntil;
    const body = await this.fetchOnce(t);
    if (body) return "fetched";
    return this.unreachableUntil !== before ? "unreachable" : "failed";
  }

  /** One fetch per tile at a time, at most UPSTREAM_CONNECTIONS at once. */
  private fetchOnce(t: Tile): Promise<Buffer | null> {
    const key = tileKey(t);
    let pending = this.inFlight.get(key);
    if (!pending) {
      if (this.waiting.length >= MAX_WAITING) return Promise.resolve(null);
      pending = this.limited(() => this.fetchAndStore(t)).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= UPSTREAM_CONNECTIONS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private async fetchAndStore(t: Tile): Promise<Buffer | null> {
    let res: Response;
    try {
      // Only the tile's numbers and the user agent: no cookie, no referrer, no redirect to anywhere else.
      res = await this.options.fetch!(`${this.upstream}/${t.z}/${t.x}/${t.y}.png`, {
        headers: { "User-Agent": TILE_USER_AGENT },
        redirect: "error",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      this.unreachableUntil = this.monotonic() + UNREACHABLE_BACKOFF_MS;
      this.warnOnce("the tile server can't be reached; cached tiles still show", { error: (error as Error)?.name ?? "unknown" });
      return null;
    }
    if (res.status !== 200) {
      this.warnOnce("the tile server refused a tile", { status: res.status });
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const length = Number(res.headers.get("content-length") ?? "0");
    if (!String(res.headers.get("content-type") ?? "").startsWith("image/png") || length > TILE_MAX_BYTES) {
      this.warnOnce("the tile server sent something that isn't a tile");
      await res.body?.cancel().catch(() => {});
      return null;
    }
    let body: Buffer;
    try {
      body = Buffer.from(await res.arrayBuffer());
    } catch (error) {
      this.warnOnce("a tile didn't finish downloading", { error: (error as Error)?.name ?? "unknown" });
      return null;
    }
    if (body.length > TILE_MAX_BYTES || !body.subarray(0, 8).equals(PNG_MAGIC)) {
      this.warnOnce("the tile server sent something that isn't a tile");
      return null;
    }
    await this.store(t, body);
    return body;
  }

  private async store(t: Tile, body: Buffer): Promise<void> {
    try {
      await this.loadIndex();
      const file = this.file(t);
      await mkdir(join(this.options.dir, String(t.z), String(t.x)), { recursive: true, mode: 0o700 });
      // Written beside it and renamed, so a reader never sees half a tile.
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, body, { mode: 0o600 });
      await rename(temp, file);
      const key = tileKey(t);
      this.total += body.length - (this.index!.get(key)?.bytes ?? 0);
      this.index!.set(key, { bytes: body.length, at: Date.now() });
      await this.evict();
    } catch (error) {
      // A full or read-only disk: the tile is still served this once.
      this.warnOnce("a tile couldn't be saved", { code: (error as NodeJS.ErrnoException)?.code ?? "unknown" });
    }
  }

  private async loadIndex(): Promise<void> {
    if (this.index) return;
    this.index = new Map();
    this.total = 0;
    const list = async (dir: string) => {
      try {
        return await readdir(dir);
      } catch {
        return [];
      }
    };
    for (const z of await list(this.options.dir)) {
      if (!/^\d+$/.test(z)) continue;
      for (const x of await list(join(this.options.dir, z))) {
        if (!/^\d+$/.test(x)) continue;
        for (const name of await list(join(this.options.dir, z, x))) {
          const m = /^(\d+)\.png$/.exec(name);
          if (!m) continue;
          try {
            const s = await stat(join(this.options.dir, z, x, name));
            this.index.set(`${z}/${x}/${m[1]}`, { bytes: s.size, at: s.mtimeMs });
            this.total += s.size;
          } catch {
            // Gone meanwhile.
          }
        }
      }
    }
  }

  /** Over the cap: the oldest tiles go until the cache is under nine tenths of it. */
  private async evict(): Promise<void> {
    if (this.total <= this.maxBytes) return;
    const oldest = [...this.index!.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key, entry] of oldest) {
      if (this.total <= this.maxBytes * 0.9) break;
      const [z, x, y] = key.split("/").map(Number) as [number, number, number];
      try {
        await unlink(this.file({ z, x, y }));
        // Its column's folder goes too once empty (rmdir refuses a folder that isn't).
        await rmdir(join(this.options.dir, String(z), String(x))).catch(() => {});
      } catch {
        // Already gone.
      }
      this.index!.delete(key);
      this.total -= entry.bytes;
    }
  }

  /** Bytes cached now (after the first write; 0 before it). */
  bytes(): number {
    return this.total;
  }
}

// ---- Warming the cache for a demo area (`walker tiles`) ----

/** The screen draws zoom 17, and 16 when the next turn is farther off; 18 is allowed for a closer look later. */
export const WARM_ZOOMS = [16, 17, 18] as const;
/** At most this many tiles in one warming run: one area, never a bulk download. */
export const WARM_MAX_TILES = 300;
export const WARM_MAX_RADIUS_M = 1500;
/** The pace between two tiles fetched from the tile server. */
export const WARM_PACE_MS = 1000;
/** Half the map's frame on the screen (280 by 410 px at most): tiles around the edge of the area show too. */
const FRAME_HALF_PX = 205;

function tileOf(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const phi = (Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n),
  };
}

/** Every tile within `radiusM` of a point (plus half the screen's map frame), at each zoom. */
export function tilesAround(lat: number, lon: number, radiusM: number, zooms: readonly number[]): Tile[] {
  const tiles: Tile[] = [];
  for (const z of zooms) {
    const metresPerPx = (156_543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
    const reach = radiusM + FRAME_HALF_PX * metresPerPx;
    const dLat = reach / 111_320;
    const dLon = reach / (111_320 * Math.cos((lat * Math.PI) / 180));
    const a = tileOf(lat + dLat, lon - dLon, z);
    const b = tileOf(lat - dLat, lon + dLon, z);
    for (let x = a.x; x <= b.x; x += 1) for (let y = a.y; y <= b.y; y += 1) tiles.push({ z, x, y });
  }
  return tiles;
}

export interface WarmReport {
  fetched: number;
  cached: number;
  failed: number;
  /** Stopped early: the tile server couldn't be reached. */
  unreachable: boolean;
}

/** Fetches each missing tile in turn, WARM_PACE_MS apart (cached ones cost nothing), and stops if offline. */
export async function warmTiles(
  cache: TileCache,
  tiles: readonly Tile[],
  deps: { sleep: (ms: number) => Promise<void>; progress?: (report: WarmReport, done: number) => void },
): Promise<WarmReport> {
  const report: WarmReport = { fetched: 0, cached: 0, failed: 0, unreachable: false };
  let fetchedBefore = false;
  for (const [i, tile] of tiles.entries()) {
    if (await cache.cached(tile)) report.cached += 1;
    else {
      if (fetchedBefore) await deps.sleep(WARM_PACE_MS);
      fetchedBefore = true;
      const outcome = await cache.warm(tile);
      if (outcome === "fetched" || outcome === "cached") report.fetched += 1;
      else report.failed += 1;
      if (outcome === "unreachable") {
        report.unreachable = true;
        break;
      }
    }
    deps.progress?.(report, i + 1);
  }
  return report;
}
