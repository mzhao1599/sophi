import { execFileSync } from "node:child_process";
import { closeSync, constants, createReadStream, openSync, readdirSync, realpathSync, write } from "node:fs";
import { basename, join } from "node:path";
import type { Cancel, Clock } from "../clock";
import { SERIAL_BAUD, SERIAL_RESCAN_MS } from "../constants";
import type { Logger } from "../log";
import type { ModuleManager, SerialConnection } from "./modules";

/**
 * Real serial ports: the tty device file, set up with `stty` and read with plain file reads, so the Pi needs
 * no native serialport addon. Run with two hand modules on a Pi 5 on 2026-10-24.
 *
 * Ports are found by physical USB path: both hand boards' CP2102 bridges advertise the same serial number,
 * so /dev/serial/by-id exposes only one of them. Which module is on a port comes from its hello.
 */
export const SERIAL_BY_PATH_DIR = "/dev/serial/by-path";

export function listSerialPorts(dir = SERIAL_BY_PATH_DIR, excludedPort?: string): string[] {
  try {
    const seen = new Set<string>();
    let excludedTarget: string | null = null;
    try {
      if (excludedPort) excludedTarget = realpathSync(excludedPort);
    } catch {
      // The configured GPS receiver may not be plugged in yet.
    }
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .sort()
      .map((name) => join(dir, name))
      .filter((path) => {
        try {
          const target = realpathSync(path);
          if (path === excludedPort || target === excludedTarget) return false;
          if (seen.has(target)) return false;
          seen.add(target);
          return true;
        } catch {
          return false; // Device was unplugged during the scan.
        }
      });
  } catch {
    return [];
  }
}

export function sttyArgs(path: string, platform: NodeJS.Platform = process.platform): string[] {
  // clocal: ignore modem control lines, so opening the port never waits for a carrier signal.
  return [platform === "darwin" ? "-f" : "-F", path, String(SERIAL_BAUD), "raw", "-echo", "clocal"];
}

export function openSerialPort(path: string, log: Logger): SerialConnection {
  execFileSync("stty", sttyArgs(path), { stdio: "ignore", timeout: 5000 });
  const fd = openSync(path, constants.O_RDWR | constants.O_NOCTTY);
  // Blocking reads run on libuv's thread pool; the systemd unit raises UV_THREADPOOL_SIZE to cover the ports.
  const input = createReadStream("", { fd, autoClose: false, highWaterMark: 1024 });
  const closeHandlers: Array<(reason: string) => void> = [];
  let closed = false;
  // Writes block on the thread pool; a module that stops reading must not use up every thread, so at most
  // one write is in flight per port and anything sent meanwhile is dropped.
  let writing = false;
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    input.destroy();
    try {
      closeSync(fd);
    } catch {
      // Already gone (unplugged).
    }
    for (const handler of closeHandlers) handler(reason);
  };
  input.on("error", (error) => finish((error as NodeJS.ErrnoException).code ?? "read error"));
  input.on("end", () => finish("end of stream"));
  return {
    id: basename(path),
    simulated: false,
    write(line) {
      if (closed || writing) return false;
      writing = true;
      write(fd, line, (error) => {
        writing = false;
        if (error) log.warn("serial write failed", { port: basename(path), code: error.code });
      });
      return true;
    },
    onData(fn) {
      input.on("data", (data) => fn(typeof data === "string" ? Buffer.from(data) : data));
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
    close() {
      finish("closed by the Pi");
    },
  };
}

/** Opens every physical serial port and retries ports that closed, every SERIAL_RESCAN_MS. */
export class SerialScanner {
  private readonly open = new Set<string>();
  private cancel: Cancel | null = null;

  constructor(
    private readonly deps: {
      clock: Clock;
      log: Logger;
      modules: ModuleManager;
      dir?: string;
      excludedPort?: string;
      /** Ports never to open: the arms' servo buses (a JSON hello at 115200 baud doesn't belong on them). */
      exclude?: (path: string) => boolean;
    },
  ) {}

  start(): void {
    this.scan();
  }

  stop(): void {
    this.cancel?.();
  }

  private scan(): void {
    for (const path of listSerialPorts(this.deps.dir, this.deps.excludedPort)) {
      if (this.open.has(path) || this.deps.exclude?.(path)) continue;
      try {
        const conn = openSerialPort(path, this.deps.log);
        this.open.add(path);
        conn.onClose(() => this.open.delete(path));
        this.deps.modules.attach(conn);
      } catch (error) {
        this.deps.log.warn("couldn't open serial port", { port: basename(path), error: (error as Error).message });
      }
    }
    this.cancel = this.deps.clock.setTimeout(() => this.scan(), SERIAL_RESCAN_MS);
  }
}
