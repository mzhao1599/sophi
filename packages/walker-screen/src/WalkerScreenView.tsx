import type { CSSProperties, SyntheticEvent } from "react";
import type { Maneuver, ScreenAction } from "@walker/contracts";
import type { NavView, ScreenView, ViewButton, ViewHold, ViewLine } from "./view";

/**
 * Draws a `ScreenView` at 800x480. Needs `screen.css` from this package. It renders only what the view says;
 * a tap calls `onPress` with the action, and the caller (the Pi's page) posts it with the view's revision.
 * Without `onPress` (the web app's Preview), the buttons are drawn but inert.
 *
 * The lift's hold control (`view.hold`) calls `onHold(true)` when a finger or key goes down on it, and
 * `onHold(false)` when the key comes up. Every other release (the finger lifting anywhere, a cancelled touch,
 * the page losing focus or being hidden, the control going) is the caller's: the Pi's page listens for those
 * on the whole window, so a release is never missed because the button moved or went. `held` draws it held.
 *
 * `tiles` is where walking directions' map tiles come from: `${tiles}/{z}/{x}/{y}.png` (the Pi's page passes
 * "/tiles", which its screen server fetches from OpenStreetMap and caches). Without it the map draws the route,
 * her dot and the markers on a plain background, as it does when a tile fails to load.
 */
export function WalkerScreenView({
  view,
  onPress,
  onHold,
  held = false,
  label = "Walker screen",
  tiles,
}: {
  view: ScreenView;
  onPress?: (action: ScreenAction) => void;
  onHold?: (pressed: boolean) => void;
  held?: boolean;
  label?: string;
  tiles?: string;
}) {
  const s = view.sizes;
  const style = {
    "--ws-smallest": `${s.smallest}px`,
    "--ws-body": `${s.body}px`,
    "--ws-message": `${s.message}px`,
    "--ws-main": `${s.main}px`,
    "--ws-button-label": `${s.button_label}px`,
    "--ws-button": `${s.button}px`,
    "--ws-gap": `${s.button_gap}px`,
    "--ws-edge": `${s.edge}px`,
    "--ws-dot": `${s.dot}px`,
    "--ws-credit": `${s.credit}px`,
    ...(view.nav
      ? { "--ws-nav-col": `${view.nav.columnPx}px`, "--ws-nav-main": `${view.nav.mainPx}px`, "--ws-nav-arrow": `${view.nav.arrowPx}px` }
      : {}),
  } as CSSProperties;
  return (
    <section
      className="ws-screen"
      data-theme={view.theme}
      data-text-size={view.textSize}
      data-layout={view.nav ? "navigating" : undefined}
      style={style}
      aria-label={label}
    >
      <header className="ws-strip">
        <span className="ws-presence">
          <span className="ws-dot" data-shape={view.strip.shape} aria-hidden="true" />
          {view.strip.word}
        </span>
        {view.strip.time ? <span className="ws-time">{view.strip.time}</span> : null}
        {view.strip.simulator ? <span className="ws-tag ws-tag-strip">Simulator</span> : null}
      </header>
      <div className="ws-one" key={view.sceneKey} data-scene={view.sceneKey}>
        {view.nav ? (
          <NavOne view={view} nav={view.nav} />
        ) : (
          <>
            <p className="ws-main" data-size={view.main.size}>
              {view.main.text}
            </p>
            {view.lines.map((line, i) => (
              <Line key={i} line={line} />
            ))}
          </>
        )}
      </div>
      {view.nav ? <NavSide nav={view.nav} tiles={tiles} /> : null}
      <footer className="ws-band" data-tall={hasButtons(view) ? "true" : "false"} data-buttons={buttonCount(view)}>
        <div className="ws-left">
          {view.left?.kind === "button" ? <Button button={view.left.button} onPress={onPress} /> : null}
          {view.left?.kind === "hint" ? <Hint word={view.left.word} /> : null}
        </div>
        <div className="ws-center">
          {view.center.lines.length ? (
            <div className="ws-center-lines">
              {view.center.lines.map((line, i) => (
                <Line key={i} line={line} />
              ))}
            </div>
          ) : null}
          {view.hold ? <HoldButton key="hold" hold={view.hold} onHold={onHold} held={held} /> : null}
          {view.center.buttons.map((b) => (
            <Button key={b.action} button={b} onPress={onPress} />
          ))}
        </div>
        <div className="ws-right">
          <Hint word={view.right} />
        </div>
      </footer>
      <p className="ws-hidden" aria-live="polite">
        {view.announce}
      </p>
    </section>
  );
}

function buttonCount(view: ScreenView): number {
  return (view.left?.kind === "button" ? 1 : 0) + view.center.buttons.length + (view.hold ? 1 : 0);
}

function hasButtons(view: ScreenView): boolean {
  return buttonCount(view) > 0;
}

function Line({ line }: { line: ViewLine }) {
  return (
    <p className="ws-line" data-size={line.size} data-strong={line.strong ? "true" : undefined} data-max-lines={line.maxLines}>
      {line.text}
      {line.simulated ? <span className="ws-tag">Simulated</span> : null}
    </p>
  );
}

function Button({ button, onPress }: { button: ViewButton; onPress?: ((action: ScreenAction) => void) | undefined }) {
  return (
    <button
      type="button"
      className="ws-button"
      data-primary={button.primary ? "true" : "false"}
      aria-pressed={button.pressed === undefined ? undefined : button.pressed}
      aria-disabled={button.disabled ? "true" : undefined}
      onClick={() => {
        if (!button.disabled) onPress?.(button.action);
      }}
    >
      <span className="ws-button-label">
        {/* An on/off switch: filled when on, hollow when off; the words "on" and "off" are in the lines above. */}
        {button.pressed !== undefined ? <span className="ws-switch" data-on={button.pressed ? "true" : "false"} aria-hidden="true" /> : null}
        {button.label}
      </span>
      {button.sublabel ? (
        <span className="ws-button-sub">
          <HintMark />
          {button.sublabel}
        </span>
      ) : null}
    </button>
  );
}

const HOLD_KEYS = new Set([" ", "Enter"]);

/**
 * The lift's hold control. A press-and-hold on a 20 mm button (or Space or Enter held), never a fine-motor
 * gesture. It captures the pointer, so a finger that slides a little stays on it; the browser's long-press
 * menu and panning are off, so a long hold is never cancelled by them. Held: filled, like a switch that is on.
 */
function HoldButton({ hold, onHold, held }: { hold: ViewHold; onHold?: ((pressed: boolean) => void) | undefined; held: boolean }) {
  return (
    <button
      type="button"
      className="ws-button ws-hold"
      data-held={held ? "true" : "false"}
      aria-pressed={held}
      // The accessible name starts with the words on it, then says how it works.
      aria-label={`${hold.label}. ${hold.sublabel ? "Keep it held while you press Confirm on the handle." : "Keep it held. Let go to stop."}`}
      onPointerDown={(event) => {
        if (!onHold) return;
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // A pointer the browser has already let go of: the window's release listeners still hear it.
        }
        onHold(true);
      }}
      onKeyDown={(event) => {
        if (!HOLD_KEYS.has(event.key)) return;
        event.preventDefault();
        if (!event.repeat) onHold?.(true);
      }}
      onKeyUp={(event) => {
        if (HOLD_KEYS.has(event.key)) onHold?.(false);
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="ws-button-label">{hold.label}</span>
      {hold.sublabel ? (
        <span className="ws-button-sub">
          <HintMark />
          {hold.sublabel}
        </span>
      ) : null}
    </button>
  );
}

/** A word over a handle, with a mark pointing down to it: shape and word, never colour alone. */
function Hint({ word }: { word: string }) {
  return (
    <span className="ws-hint">
      <HintMark />
      {word}
    </span>
  );
}

function HintMark() {
  return (
    <svg className="ws-hint-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v14M5 11l7 7 7-7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---- Walking directions ----

/** The next thing to do: the arrow and its word with the distance beside it, then the street; or a phase sentence. */
function NavOne({ view, nav }: { view: ScreenView; nav: NavView }) {
  const main = (
    <p className="ws-main" data-size="nav" data-wraps={nav.mainWraps ? "true" : "false"}>
      {view.main.text}
    </p>
  );
  if (!nav.turn) {
    return (
      <>
        {main}
        {view.lines.map((line, i) => (
          <Line key={i} line={line} />
        ))}
      </>
    );
  }
  const beside = view.lines.filter((l) => l.strong);
  const under = view.lines.filter((l) => !l.strong);
  return (
    <>
      <div className="ws-turn">
        <TurnArrow maneuver={nav.turn} />
        <div className="ws-turn-words">
          {main}
          {beside.map((line, i) => (
            <Line key={i} line={line} />
          ))}
        </div>
      </div>
      {under.map((line, i) => (
        <Line key={i} line={line} />
      ))}
    </>
  );
}

/** Each arrow: the way she walks now (the stem, from the bottom) and where it goes, with a head at its end. */
const ARROWS: Record<Exclude<Maneuver, "arrive">, { d: string; tip: [number, number]; dir: [number, number] }> = {
  straight: { d: "M50 94 V30", tip: [50, 30], dir: [0, -1] },
  left: { d: "M58 94 V60 Q58 44 42 44 H32", tip: [32, 44], dir: [-1, 0] },
  right: { d: "M42 94 V60 Q42 44 58 44 H68", tip: [68, 44], dir: [1, 0] },
  slight_left: { d: "M58 94 V62 L36 38", tip: [36, 38], dir: [-0.68, -0.74] },
  slight_right: { d: "M42 94 V62 L64 38", tip: [64, 38], dir: [0.68, -0.74] },
  sharp_left: { d: "M64 94 V34 L36 62", tip: [36, 62], dir: [-0.71, 0.71] },
  sharp_right: { d: "M36 94 V34 L64 62", tip: [64, 62], dir: [0.71, 0.71] },
  u_turn: { d: "M66 94 V40 A16 16 0 0 0 34 40 V62", tip: [34, 62], dir: [0, 1] },
};

function head([x, y]: [number, number], [dx, dy]: [number, number]): string {
  const len = 16;
  const half = 15;
  const tip = [x + dx * len, y + dy * len];
  const a = [x - dy * half, y + dx * half];
  const b = [x + dy * half, y - dx * half];
  return [tip, a, b].map((p) => p.map((n) => Math.round(n * 10) / 10).join(",")).join(" ");
}

function TurnArrow({ maneuver }: { maneuver: Maneuver }) {
  return (
    <svg className="ws-turn-arrow" viewBox="0 0 100 100" aria-hidden="true" data-maneuver={maneuver}>
      {maneuver === "arrive" ? (
        <>
          <path d="M50 94 C42 80 24 62 24 42 A26 26 0 0 1 76 42 C76 62 58 80 50 94 Z" className="ws-arrow-fill" />
          <circle cx="50" cy="42" r="10" className="ws-arrow-hole" />
        </>
      ) : (
        <>
          <path d={ARROWS[maneuver].d} className="ws-arrow-stroke" />
          <polygon points={head(ARROWS[maneuver].tip, ARROWS[maneuver].dir)} className="ws-arrow-fill" />
        </>
      )}
    </svg>
  );
}

function hideTile(event: SyntheticEvent<HTMLImageElement>) {
  // A tile that didn't load (offline and not cached): the plain background shows, with the route and the dot.
  event.currentTarget.style.visibility = "hidden";
}

/** The map (a plain tile grid: no map library, no gestures, no animation), then the distance and time left. */
function NavSide({ nav, tiles }: { nav: NavView; tiles: string | undefined }) {
  const { map } = nav;
  const base = tiles?.replace(/\/+$/, "");
  const parts = [map.position ? (nav.simulated ? "your simulated position" : "your position") : null, "the route ahead", map.step ? "the next turn" : null, "the place"].filter(Boolean);
  return (
    <div className="ws-nav-side">
      <div className="ws-map" role="img" aria-label={`Map: ${parts.join(", ")}. Map data © OpenStreetMap contributors.`}>
        {/* The frame is centred in the box, whatever height the box gets, so her dot stays in the middle. */}
        <div className="ws-map-frame" style={{ width: map.width, height: map.height, marginLeft: -map.width / 2, marginTop: -map.height / 2 }}>
          {base
            ? map.tiles.map((t) => (
                <img key={t.key} className="ws-map-tile" src={`${base}/${t.key}.png`} alt="" draggable={false} style={{ left: t.left, top: t.top }} onError={hideTile} />
              ))
            : null}
          <svg className="ws-map-lines" width={map.width} height={map.height} viewBox={`0 0 ${map.width} ${map.height}`} aria-hidden="true">
          <polyline points={map.route} className="ws-route-casing" />
          <polyline points={map.route} className="ws-route" />
          <path
            d={`M${map.destination.x} ${map.destination.y} c-5 -9 -16 -18 -16 -30 a16 16 0 0 1 32 0 c0 12 -11 21 -16 30 z`}
            className="ws-map-place"
          />
          <circle cx={map.destination.x} cy={map.destination.y - 30} r="6" className="ws-map-place-hole" />
          {map.step ? <circle cx={map.step.x} cy={map.step.y} r="12" className="ws-map-step" /> : null}
          {map.position ? (
            <>
              <circle cx={map.position.x} cy={map.position.y} r="17" className="ws-map-me-ring" data-simulated={nav.simulated ? "true" : "false"} />
              <circle cx={map.position.x} cy={map.position.y} r="9" className="ws-map-me" />
            </>
          ) : null}
          </svg>
        </div>
        {nav.simulated ? <span className="ws-tag ws-map-tag">Simulated</span> : null}
        <span className="ws-map-credit">© OpenStreetMap contributors</span>
      </div>
      {nav.info.length ? (
        <div className="ws-nav-info">
          {nav.info.map((line, i) => (
            <Line key={i} line={line} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
