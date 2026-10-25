import type { Logger } from "../log";
import { TileCache, WARM_MAX_RADIUS_M, WARM_MAX_TILES, WARM_ZOOMS, readTileSettings, tilesAround, warmTiles, type WarmReport } from "./tiles";

export const TILES_USAGE = `  walker tiles --around <lat>,<lon> [--radius <metres>] [--zoom <16-18>] [--dir <folder>] [--sim]
      Fills the walker screen's map tile cache for a demo area from OpenStreetMap's tile server, about one
      tile a second, at most ${WARM_MAX_TILES} tiles (the tile usage policy: no bulk downloads). --radius
      defaults to 500 m (at most ${WARM_MAX_RADIUS_M}); --zoom to 16-17, the zooms the screen draws (one zoom,
      or a range from 16 to 18). The folder is --dir, else WALKER_TILE_DIR, else the state folder's tiles/
      (--sim: ~/.cache/sophi-walker/tiles, the simulator's). On the Pi run it as the service's user
      (sudo -u steady), so the service can still add tiles. Tiles already cached are skipped.`;

export interface TilesArgs {
  lat: number;
  lon: number;
  radiusM: number;
  zooms: number[];
  dir: string;
}

/** The command's flags, checked; a message for anything wrong. */
export function parseTilesArgs(flags: Map<string, string | true>, env: NodeJS.ProcessEnv): TilesArgs | { error: string } {
  const text = (name: string) => {
    const v = flags.get(name);
    return typeof v === "string" ? v : undefined;
  };
  const around = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text("around") ?? "");
  if (!around) return { error: "--around needs <lat>,<lon>, like --around 37.8098,-122.2575" };
  const lat = Number(around[1]);
  const lon = Number(around[2]);
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return { error: "--around is off the map: latitude -85 to 85, longitude -180 to 180" };
  const radiusM = Number(text("radius") ?? "500");
  if (!Number.isFinite(radiusM) || radiusM < 0 || radiusM > WARM_MAX_RADIUS_M) return { error: `--radius is metres, from 0 to ${WARM_MAX_RADIUS_M}` };
  const zoom = /^(\d+)(?:-(\d+))?$/.exec(text("zoom") ?? "16-17");
  const from = Number(zoom?.[1]);
  const to = Number(zoom?.[2] ?? zoom?.[1]);
  const allowed = WARM_ZOOMS as readonly number[];
  if (!zoom || !allowed.includes(from) || !allowed.includes(to) || to < from) return { error: `--zoom is one zoom or a range within ${allowed[0]}-${allowed.at(-1)}` };
  const zooms = allowed.filter((z) => z >= from && z <= to);
  return { lat, lon, radiusM, zooms, dir: text("dir") ?? readTileSettings(env, flags.get("sim") === true).dir };
}

export interface TilesCommandDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
  log: Logger;
}

/** `walker tiles`: 0 when every tile is cached, 1 if any failed, 2 for a usage error. */
export async function tilesCommand(flags: Map<string, string | true>, deps: TilesCommandDeps): Promise<number> {
  const args = parseTilesArgs(flags, deps.env);
  if ("error" in args) {
    deps.out(`${args.error}\n\n${TILES_USAGE}`);
    return 2;
  }
  const tiles = tilesAround(args.lat, args.lon, args.radiusM, args.zooms);
  if (tiles.length > WARM_MAX_TILES) {
    deps.out(`That is ${tiles.length} tiles, more than ${WARM_MAX_TILES}: use a smaller --radius or fewer zooms.`);
    return 2;
  }
  deps.out(`Warming ${tiles.length} map tiles (zoom ${args.zooms.join(", ")}) in ${args.dir}, about one a second.`);
  const cache = new TileCache({ dir: args.dir, fetch: deps.fetch, log: deps.log });
  const line = (r: WarmReport) => `${r.fetched} fetched, ${r.cached} already cached, ${r.failed} failed`;
  const report = await warmTiles(cache, tiles, {
    sleep: deps.sleep,
    progress: (r, done) => {
      if (done % 25 === 0) deps.out(`  ${done} of ${tiles.length}: ${line(r)}`);
    },
  });
  deps.out(`${report.unreachable ? "Stopped: the tile server can't be reached. " : ""}Map tiles: ${line(report)}, of ${tiles.length}.`);
  return report.failed || report.unreachable ? 1 : 0;
}
