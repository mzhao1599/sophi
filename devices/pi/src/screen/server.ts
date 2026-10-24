import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { extname, join } from "node:path";
import { ScreenPressSchema, ScreenShownSchema, type ScreenPress, type ScreenShown, type ScreenState } from "@walker/contracts";
import type { Logger } from "../log";

/**
 * The walker screen's local server (docs/interfaces.md, "The walker screen's local contract"): the page, its
 * files, a Server-Sent Events stream of `ScreenState`, and the page's two POSTs, on 127.0.0.1 only.
 *
 * 127.0.0.1 is reachable from any page in any browser on the same machine (the simulator runs on a laptop),
 * so every request must come from loopback, name `Host: 127.0.0.1:<port>` (which stops DNS rebinding), and,
 * when it carries an `Origin`, name this server's own. The stream and the POSTs also need the per-boot token,
 * which only the page this server sends knows (another site can't read that page: no CORS headers are ever
 * sent). The page and its files need no token: the kiosk's wait script must be able to fetch the page.
 *
 * What the token does not stop: a local user or process on the same machine. Anything that can open a socket
 * to 127.0.0.1 can GET the page, read the token, and watch the stream (the captions: her words and Sophi's
 * replies). On the Pi that means someone already logged in to it; presses aren't acted on yet. The kiosk's
 * placeholder, in turn, trusts whatever answers on 127.0.0.1:8740.
 *
 * Never logged: state bodies, the token, request URLs (the stream's carries the token), message text, heard
 * words or replies. A failure to start is one log line, and the walker carries on without its screen.
 */

export interface ScreenServerOptions {
  port: number;
  /** The page's built files (scripts/bundle.mjs writes them to dist/screen-page beside walker.mjs). */
  assetsDir: string;
  log: Logger;
  /** The state a new stream starts with. */
  current: () => ScreenState | null;
  /** Fixed in tests; otherwise 32 random bytes made at start. */
  token?: string;
  /** The page drew a revision. */
  onShown?: (shown: ScreenShown) => void;
  onPress?: (press: ScreenPress) => void;
}

export interface ScreenServer {
  readonly url: string;
  readonly port: number;
  /** The address it listens on: always 127.0.0.1. */
  readonly address: string | null;
  publish(state: ScreenState): void;
  /** Streams open now. */
  clients(): number;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
const MAX_BODY_BYTES = 4096;
const MAX_STREAMS = 8;
const KEEPALIVE_MS = 15_000;
/** A screen that stops reading (a frozen browser) is dropped once this much is waiting to be sent to it. */
const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_CONNECTIONS = 32;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Loopback only, as the socket sees it (IPv4, or IPv4 mapped into IPv6). */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

/** Why a request is refused, or null when it may go on (the token is checked per route). */
export function refusal(req: Pick<IncomingMessage, "headers"> & { socket: Pick<Socket, "remoteAddress"> }, port: number): string | null {
  if (!isLoopback(req.socket.remoteAddress)) return "not loopback";
  if (req.headers.host !== `127.0.0.1:${port}`) return "wrong host";
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}`) return "wrong origin";
  return null;
}

function tokenMatches(expected: Buffer, given: string | string[] | null | undefined): boolean {
  if (typeof given !== "string") return false;
  const buffer = Buffer.from(given);
  return buffer.length === expected.length && timingSafeEqual(buffer, expected);
}

function page(token: string): string {
  // The token is base64url, so it needs no escaping in an attribute.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=800, height=480, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="screen-token" content="${token}">
<title>Sophi walker screen</title>
<link rel="stylesheet" href="/screen/assets/page.css">
</head>
<body>
<div id="root"></div>
<script src="/screen/assets/page.js"></script>
</body>
</html>
`;
}

function send(res: ServerResponse, status: number, body = "", type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // Past the limit it keeps reading (and dropping) the rest, so the 413 still reaches the page.
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => resolve(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/** Starts the server, or logs one line and returns null (port taken, no page files): the walker carries on. */
export async function startScreenServer(options: ScreenServerOptions): Promise<ScreenServer | null> {
  const { port, log } = options;
  let assets: Map<string, { body: Buffer; type: string }>;
  try {
    assets = new Map(
      readdirSync(options.assetsDir)
        .filter((name) => TYPES[extname(name)])
        .map((name) => [name, { body: readFileSync(join(options.assetsDir, name)), type: TYPES[extname(name)]! }]),
    );
    if (!assets.has("page.js") || !assets.has("page.css")) throw new Error("page.js or page.css is missing");
  } catch (error) {
    log.warn("walker screen not started: its page files are missing; the walker runs without its screen", {
      dir: options.assetsDir,
      error: (error as Error).message.slice(0, 120),
    });
    return null;
  }
  const token = options.token ?? randomBytes(32).toString("base64url");
  const expected = Buffer.from(token);
  const html = page(token);
  const streams = new Set<ServerResponse>();
  // The port asked for, or the one the system picked for port 0 (tests).
  let actualPort = port;

  const frame = (state: ScreenState) => `event: state\ndata: ${JSON.stringify(state)}\n\n`;

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const refused = refusal(req, actualPort);
    if (refused) return send(res, refused === "not loopback" ? 403 : 421, "Refused.");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${actualPort}`);
    const path = url.pathname;

    if (req.method === "GET" && path === "/") return send(res, 200, html, "text/html; charset=utf-8");
    if (req.method === "GET" && path.startsWith("/screen/assets/")) {
      const file = assets.get(path.slice("/screen/assets/".length));
      if (!file) return send(res, 404, "Not found.");
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": file.type, "Content-Length": file.body.length });
      return res.end(file.body);
    }
    // The page asks this after its stream was refused: 204 means its token is still good (the stream was full
    // or dropped, so it reconnects), 403 means the walker service restarted (it reloads for the new token).
    if (req.method === "GET" && path === "/screen/check") {
      if (!tokenMatches(expected, url.searchParams.get("token"))) return send(res, 403, "Refused.");
      res.writeHead(204, SECURITY_HEADERS);
      return res.end();
    }
    if (req.method === "GET" && path === "/screen/events") {
      if (!tokenMatches(expected, url.searchParams.get("token"))) return send(res, 403, "Refused.");
      if (streams.size >= MAX_STREAMS) return send(res, 503, "Too many screens.");
      res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write("retry: 1000\n\n");
      const current = options.current();
      if (current) res.write(frame(current));
      streams.add(res);
      log.info("walker screen connected", { streams: streams.size });
      req.socket.setNoDelay(true);
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), KEEPALIVE_MS);
      res.on("close", () => {
        clearInterval(keepalive);
        streams.delete(res);
        log.info("walker screen disconnected", { streams: streams.size });
      });
      return;
    }
    if (req.method === "POST" && (path === "/screen/shown" || path === "/screen/press")) {
      if (!tokenMatches(expected, req.headers["x-screen-token"])) return send(res, 403, "Refused.");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, "JSON only.");
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, "Too large.");
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return send(res, 400, "Not JSON.");
      }
      if (path === "/screen/shown") {
        const shown = ScreenShownSchema.safeParse(json);
        if (!shown.success) return send(res, 400, "Not a ScreenShown.");
        options.onShown?.(shown.data);
      } else {
        const press = ScreenPressSchema.safeParse(json);
        if (!press.success) return send(res, 400, "Not a ScreenPress.");
        options.onPress?.(press.data);
      }
      res.writeHead(204, SECURITY_HEADERS);
      return res.end();
    }
    return send(res, 404, "Not found.");
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log.warn("walker screen request failed", { error: (error as Error)?.name ?? "unknown" });
      if (!res.headersSent) send(res, 500, "Error.");
      else res.destroy();
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.maxConnections = MAX_CONNECTIONS;

  const listening = await new Promise<boolean>((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      log.warn(
        error.code === "EADDRINUSE"
          ? "walker screen not started: its port is taken; the walker runs without its screen"
          : "walker screen not started; the walker runs without its screen",
        { port, code: error.code ?? "unknown" },
      );
      resolve(false);
    });
    server.listen(port, "127.0.0.1", () => resolve(true));
  });
  if (!listening) return null;
  const address = server.address();
  if (address && typeof address === "object") actualPort = address.port;
  // After it started, an error is logged and the walker carries on (an unhandled 'error' would end the process).
  server.on("error", (error: NodeJS.ErrnoException) => log.warn("walker screen server error", { code: error.code ?? "unknown" }));
  const url = `http://127.0.0.1:${actualPort}/`;

  return {
    url,
    port: actualPort,
    address: typeof address === "object" && address ? address.address : null,
    publish(state) {
      const data = frame(state);
      for (const res of streams) {
        try {
          if (res.writableLength > MAX_BUFFERED_BYTES) res.destroy();
          else res.write(data);
        } catch {
          res.destroy();
        }
      }
    },
    clients: () => streams.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
