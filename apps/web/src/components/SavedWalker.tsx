"use client";

import type { ModuleId } from "@walker/contracts";
import { nameOf, partStates } from "@/lib/walker";
import { WalkerDiagram } from "./WalkerDiagram";

const nothing = () => undefined;

/** The walker someone ordered, drawn again at the end of the demo: a picture, with its parts named. */
export function SavedWalker({ selected }: { selected: readonly ModuleId[] }) {
  return (
    <WalkerDiagram
      recs={[]}
      facts={[]}
      states={partStates([], selected)}
      review={false}
      problems={[]}
      frozen={null}
      onToggle={nothing}
      highlight={null}
      onHighlight={nothing}
      caption={`The walker in this demo order: ${selected.map(nameOf).join(", ")}.`}
      view="front"
    />
  );
}
