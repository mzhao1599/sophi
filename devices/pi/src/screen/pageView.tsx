import type { ScreenAction } from "@walker/contracts";
import { WalkerScreenView, type ScreenView } from "@walker/walker-screen";

/**
 * What the walker screen's page draws, with no browser APIs, so a test can render it (test/screen-page.test.tsx):
 * the waiting screen before the first state or after the stream is lost, and otherwise the view the Pi's state
 * makes. The lift's hold control is drawn only when the view has one; page.tsx wires its presses to HoldControl.
 */
export function Waiting() {
  return (
    <main className="pi-waiting" aria-live="polite">
      <p className="pi-waiting-main">Sophi</p>
      <p>Waiting for the walker service.</p>
    </main>
  );
}

export function ScreenPage({
  view,
  held,
  onPress,
  onHold,
}: {
  /** null: no state yet, or the stream is lost (the last state may no longer be true). */
  view: ScreenView | null;
  held: boolean;
  onPress: (action: ScreenAction) => void;
  onHold: (pressed: boolean) => void;
}) {
  if (!view) return <Waiting />;
  return <WalkerScreenView view={view} onPress={onPress} onHold={onHold} held={held && view.hold !== null} />;
}
