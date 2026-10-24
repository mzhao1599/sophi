import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ScreenStateSchema, type ScreenAction, type ScreenState } from "@walker/contracts";
import { WalkerScreenView, screenView, type ScreenView } from "@walker/walker-screen";
import "@walker/walker-screen/screen.css";
import "./page.css";

/**
 * The walker screen's page, served by the walker service on 127.0.0.1 (src/screen/server.ts). It draws what
 * the Pi sends and decides nothing: each `state` event is a ScreenState, drawn with the walker-screen package.
 * After drawing a revision it tells the Pi (`POST /screen/shown`); a tap is `POST /screen/press`. Both carry the
 * per-boot token the server put in this page.
 *
 * The only thing it knows by itself is whether the walker service is answering: if the stream drops and
 * doesn't come back within LOST_MS, it stops showing the last state (which may no longer be true) and says
 * it is waiting for the walker service.
 */
const LOST_MS = 5000;
const token = document.querySelector<HTMLMetaElement>('meta[name="screen-token"]')?.content ?? "";

function post(path: string, body: unknown): void {
  void fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Screen-Token": token },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

function Waiting() {
  return (
    <main className="pi-waiting" aria-live="polite">
      <p className="pi-waiting-main">Sophi</p>
      <p>Waiting for the walker service.</p>
    </main>
  );
}

function App() {
  const [state, setState] = useState<ScreenState | null>(null);
  const [lost, setLost] = useState(false);
  const lastGood = useRef<ScreenView | null>(null);

  useEffect(() => {
    let events: EventSource | null = null;
    let lostTimer: number | undefined;
    let probe: number | undefined;
    const connect = () => {
      const source = new EventSource(`/screen/events?token=${encodeURIComponent(token)}`);
      events = source;
      source.addEventListener("state", (event) => {
        const parsed = ScreenStateSchema.safeParse(JSON.parse((event as MessageEvent<string>).data));
        if (!parsed.success) return; // keep the last good one; the Pi's tests check every state it sends
        window.clearTimeout(lostTimer);
        lostTimer = undefined;
        setLost(false);
        setState(parsed.data);
      });
      source.addEventListener("error", () => {
        if (lostTimer === undefined) lostTimer = window.setTimeout(() => setLost(true), LOST_MS);
        // Refused for good (CLOSED): ask the service whether this page's token is still good. 403: it
        // restarted with a new token, so load the page afresh. 204: it was full or dropped this stream, so
        // connect again. No answer: keep asking. Never reload while it doesn't answer (the browser would show
        // its own error page instead of this one).
        if (source.readyState === EventSource.CLOSED && probe === undefined) {
          probe = window.setInterval(() => {
            fetch(`/screen/check?token=${encodeURIComponent(token)}`, { cache: "no-store" }).then(
              (res) => {
                if (res.status === 403) window.location.reload();
                else if (res.status === 204) {
                  window.clearInterval(probe);
                  probe = undefined;
                  connect();
                }
              },
              () => {},
            );
          }, 2000);
        }
      });
    };
    connect();
    return () => {
      window.clearTimeout(lostTimer);
      window.clearInterval(probe);
      events?.close();
    };
  }, []);

  // "Shown" once the browser has painted this revision (the second frame after the commit).
  useEffect(() => {
    if (!state) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        document.documentElement.dataset.drawnRevision = String(state.revision);
        post("/screen/shown", {
          revision: state.revision,
          item_id: lastGood.current?.itemId ?? null,
          settings_version: state.settings.version,
          settings_pending_local: state.settings.pending_local,
        });
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [state]);

  if (lost || !state) return <Waiting />;
  let view: ScreenView;
  try {
    view = screenView(state);
    lastGood.current = view;
  } catch {
    if (!lastGood.current) return <Waiting />;
    view = lastGood.current;
  }
  const press = (action: ScreenAction) => post("/screen/press", { revision: state.revision, action });
  return <WalkerScreenView view={view} onPress={press} />;
}

createRoot(document.getElementById("root")!).render(<App />);
