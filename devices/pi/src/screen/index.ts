import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScreenState } from "@walker/contracts";
import type { Bus } from "../bus";
import type { Clock } from "../clock";
import { SCREEN_DEFAULT_PORT } from "../constants";
import type { Logger } from "../log";
import type { ModuleManager } from "../serial/modules";
import type { WalkerService } from "../service";
import { attachScreen, seedScreen, startingSettings } from "./attach";
import { startScreenServer, type ScreenServer } from "./server";
import { TileCache, readTileSettings, type TileMode } from "./tiles";

/** WALKER_SCREEN_PORT: unset for the default, `off` for no screen, or a port from 1024 to 65535. */
export function readScreenPort(value: string | undefined): { port: number } | { off: string } {
  if (value === undefined || value === "") return { port: SCREEN_DEFAULT_PORT };
  if (value === "off") return { off: "WALKER_SCREEN_PORT=off" };
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { off: "WALKER_SCREEN_PORT isn't a port from 1024 to 65535" };
  return { port };
}

/** Where bundle.mjs puts the page: dist/screen-page, beside walker.mjs (and /opt/steady-walker/screen-page on the Pi). */
export function defaultScreenAssets(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "screen-page");
}

export interface WalkerScreenOptions {
  bus: Bus;
  clock: Clock;
  log: Logger;
  service: WalkerService;
  modules: ModuleManager;
  simulator: boolean;
  port: number;
  assetsDir: string;
  /** The local wall time, or null while the clock has never synced. */
  localTime: () => string | null;
  /** WALKER_SCREEN_GREETING: "Good evening, Nan" on the clock (up to 12 characters), until the circle brings her name. */
  greeting?: string;
  /** Log each drawn revision's state name and how long it took to draw (the simulator; never the body). */
  logDrawn?: boolean;
  /**
   * Map tiles for walking directions: the cache folder and whether it fetches. By default from WALKER_TILE_DIR
   * and WALKER_TILES (`readTileSettings` in tiles.ts); `fetch` replaces the network in tests.
   */
  tiles?: { dir: string; mode: TileMode; fetch?: typeof globalThis.fetch };
}

export interface WalkerScreen {
  /** The page's address, or null when the server didn't start (logged once; the walker carries on). */
  url: string | null;
  stop(): Promise<void>;
}

/**
 * The walker screen inside the walker service: the state machine on the bus, and the local server. Call after
 * `service.start()`. Never throws: anything that fails is logged and the walker runs without its screen.
 */
export async function startWalkerScreen(options: WalkerScreenOptions): Promise<WalkerScreen> {
  const { log, clock } = options;
  let server: ScreenServer | null = null;
  const sentAt = new Map<number, { mono: number; state: ScreenState["screen"]["state"] }>();
  let attached: ReturnType<typeof attachScreen> | null = null;
  try {
    attached = attachScreen({
      bus: options.bus,
      clock,
      log,
      service: options.service,
      modules: options.modules,
      simulator: options.simulator,
      settings: startingSettings(options.greeting, clock.now()),
      localTime: options.localTime,
      onState: (state) => {
        sentAt.set(state.revision, { mono: clock.monotonic(), state: state.screen.state });
        if (sentAt.size > 32) sentAt.delete(sentAt.keys().next().value!);
        server?.publish(state);
      },
    });
    seedScreen(attached.machine, options.service);
    const machine = attached.machine;
    const tileSettings = options.tiles ?? readTileSettings(process.env, options.simulator);
    const tiles =
      tileSettings.mode === "off"
        ? null
        : new TileCache({ dir: tileSettings.dir, fetch: tileSettings.mode === "fetch" ? (options.tiles?.fetch ?? globalThis.fetch) : null, log });
    server = await startScreenServer({
      port: options.port,
      assetsDir: options.assetsDir,
      log,
      current: () => machine.current(),
      onShown: (shown) => {
        const sent = sentAt.get(shown.revision);
        if (options.logDrawn && sent) {
          log.info("walker screen drawn", { revision: shown.revision, state: sent.state, ms: Math.round(clock.monotonic() - sent.mono) });
        }
      },
      // Presses go on the bus with the state that revision drew. Only the route's End route and Repeat act so
      // far (the service listens); "My screen" comes with the circle piece.
      onPress: (press) => {
        const state = sentAt.get(press.revision)?.state ?? null;
        log.info("walker screen press", { action: press.action, revision: press.revision, state });
        options.bus.emit("screenPress", { action: press.action, revision: press.revision, state });
      },
      // The lift's hold control, stamped on receipt: the motion coordinator maps it to the lift's hold lease.
      monotonic: () => clock.monotonic(),
      onHold: (hold) => options.bus.emit("screenHold", hold),
      tiles,
    });
    if (server) log.info("walker screen page", { url: server.url, map_tiles: tileSettings.mode });
    // Sophi offers to show something on the screen only while a page is there to draw it.
    const running = server;
    if (running) options.service.setScreen({ connected: () => running.clients() > 0 });
  } catch (error) {
    log.warn("walker screen not started; the walker runs without its screen", { error: (error as Error)?.name ?? "unknown" });
  }
  return {
    url: server?.url ?? null,
    stop: async () => {
      options.service.setScreen(null);
      attached?.detach();
      await server?.close();
    },
  };
}
