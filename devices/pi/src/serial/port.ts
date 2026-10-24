import { execFileSync } from "node:child_process";
import { closeSync, constants, createReadStream, openSync, readdirSync, write } from "node:fs";
import { basename, join } from "node:path";
import type { Cancel, Clock } from "../clock";
import { SERIAL_BAUD, SERIAL_RESCAN_MS } from "../constants";
import type { Logger } from "../log";
import type { ModuleManager, SerialConnection } from "./modules";

/**
 * Real serial ports: the tty device file, set up with `stty` and read with plain file reads, so the Pi needs
 * no native serialport addon. Not yet run on a Pi.
 *
 * Ports are found by stable USB identity under /dev/serial/by-id (udev names each link after the adapter's
 * vendor, model and serial number), never by /dev/ttyUSB0, whose number changes with plug order. Which module
 * is on a port comes from its hello, not from the path.
 */
export const SERIAL_BY_ID_DIR = "/dev/serial/by-id";

export function listSerialPorts(dir = SERIAL_BY_ID_DIR): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith("."))
      .sort()
      .map((name) => join(dir, name));
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

/** Opens every port that appears under /dev/serial/by-id, and retries ports that closed, every SERIAL_RESCAN_MS. */
export class SerialScanner {
  private readonly open = new Set<string>();
  private cancel: Cancel | null = null;

  constructor(
    private readonly deps: { clock: Clock; log: Logger; modules: ModuleManager; dir?: string },
  ) {}

  start(): void {
    this.scan();
  }

  stop(): void {
    this.cancel?.();
  }

  private scan(): void {
    for (const path of listSerialPorts(this.deps.dir)) {
      if (this.open.has(path)) continue;
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
