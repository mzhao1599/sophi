import type { CSSProperties } from "react";
import type { ScreenAction } from "@walker/contracts";
import type { ScreenView, ViewButton, ViewHold, ViewLine } from "./view";

/**
 * Draws a `ScreenView` at 800x480. Needs `screen.css` from this package. It renders only what the view says;
 * a tap calls `onPress` with the action, and the caller (the Pi's page) posts it with the view's revision.
 * Without `onPress` (the web app's Preview), the buttons are drawn but inert.
 *
 * The lift's hold control (`view.hold`) calls `onHold(true)` when a finger or key goes down on it, and
 * `onHold(false)` when the key comes up. Every other release (the finger lifting anywhere, a cancelled touch,
 * the page losing focus or being hidden, the control going) is the caller's: the Pi's page listens for those
 * on the whole window, so a release is never missed because the button moved or went. `held` draws it held.
 */
export function WalkerScreenView({
  view,
  onPress,
  onHold,
  held = false,
  label = "Walker screen",
}: {
  view: ScreenView;
  onPress?: (action: ScreenAction) => void;
  onHold?: (pressed: boolean) => void;
  held?: boolean;
  label?: string;
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
  } as CSSProperties;
  return (
    <section className="ws-screen" data-theme={view.theme} data-text-size={view.textSize} style={style} aria-label={label}>
      <header className="ws-strip">
        <span className="ws-presence">
          <span className="ws-dot" data-shape={view.strip.shape} aria-hidden="true" />
          {view.strip.word}
        </span>
        {view.strip.time ? <span className="ws-time">{view.strip.time}</span> : null}
        {view.strip.simulator ? <span className="ws-tag ws-tag-strip">Simulator</span> : null}
        {view.strip.bench ? <span className="ws-tag ws-tag-strip">Bench mode</span> : null}
      </header>
      <div className="ws-one" key={view.sceneKey} data-scene={view.sceneKey}>
        <p className="ws-main" data-size={view.main.size}>
          {view.main.text}
        </p>
        {view.lines.map((line, i) => (
          <Line key={i} line={line} />
        ))}
      </div>
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
    <p className="ws-line" data-size={line.size}>
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
