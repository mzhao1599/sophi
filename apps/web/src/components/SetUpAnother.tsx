"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { forgetStoredSession } from "@/lib/useOnboarding";

/**
 * One press from the end of the demo back to a fresh first frame: deletes this tab's demo answers on
 * the server, then opens the demo page with nothing in it. If the delete fails, nothing is forgotten
 * and it says so, so it can be pressed again.
 */
export function SetUpAnother({ className }: { className?: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");

  async function go() {
    if (state === "working") return;
    setState("working");
    if (await forgetStoredSession()) router.push("/");
    else setState("failed");
  }

  return (
    <>
      <button
        type="button"
        className={`button button-primary ${className ?? ""}`}
        onClick={() => void go()}
        aria-disabled={state === "working" || undefined}
        aria-describedby="another-note"
      >
        <span key={state === "working" ? "a" : "b"} className="fade-text">
          {state === "working" ? "Deleting your answers" : "Set up another walker"}
        </span>
      </button>
      <span id="another-note" className="visually-hidden">
        Deletes this demo&apos;s answers and starts again with just the frame.
      </span>
      {state === "failed" ? (
        <p role="alert" className="field-hint">
          Your answers couldn&apos;t be deleted just now. Please try again.
        </p>
      ) : null}
    </>
  );
}
