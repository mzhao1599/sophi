import { WALKER_TIMEOUT_MS, type AssistantResult, type WalkerAssistant } from "./assistant";

/**
 * The walker assistant with a backup model: both are asked at the same moment, and the main model's
 * answer is used unless it hasn't come `backupAfterMs` after the start; from then on, the first usable
 * answer wins (the backup's is usually ready by then). Measured live on 2026-10-23 (210 turns): 3.7 Flash
 * took over 4.5 s on 33 turns and once hit the 8 s deadline; 3.6 Flash answered every turn within 3.3 s.
 *
 * - The main model fails early (an API error, a bad reply twice, its deadline): the backup's answer is
 *   used as soon as there is one, without waiting for the switch-over.
 * - A refusal from the main model before an answer is picked is final: the backup doesn't overrule it.
 * - The backup fails: the main model's answer is awaited, as with no backup.
 * - Both fail: the failure of the one that failed last (what the person waited for) is reported, and the
 *   service answers with its fixed line.
 *
 * The switch-over comes at most half a second before the turn's own limit, so a backup answer that is
 * ready never loses to the deadline. Once an answer is picked the other attempt is cancelled, so it
 * can't start a retry. The result's `ms` is the time to the pick (what the person waited), and `model`
 * names the model whose answer (or failure) it is. Everything after this step is the same for either
 * model: the server's rules word any offer, and only the person's Confirm changes the walker. Each model
 * keeps its own one retry (a broken reply, or "clear"/"safe"), so a backup answer that needed its retry
 * can come later than usual, still within the turn's deadline.
 */

/** The switch-over comes at least this long before the turn's own limit. */
export const BACKUP_MARGIN_MS = 500;

export function createHedgedAssistant({ main, backup, backupAfterMs }: { main: WalkerAssistant; backup: WalkerAssistant; backupAfterMs: number }): WalkerAssistant {
  return {
    provider: main.provider,
    reply(status, source, words, now, limitMs = WALKER_TIMEOUT_MS, signal, toolResults, recipients, navigation, help) {
      const started = Date.now();
      const cancel = new AbortController();
      const both = signal ? AbortSignal.any([signal, cancel.signal]) : cancel.signal;
      // An attempt that throws (it shouldn't: failures are results) counts as a model error.
      const crashed = (): AssistantResult => ({ ok: false, reason: "model_error", attempts: 1, ms: Date.now() - started, provider: main.provider });
      // Both models see the same turn, tool results, message recipients, route and help included.
      const fromMain = main.reply(status, source, words, now, limitMs, both, toolResults, recipients, navigation, help).catch(crashed);
      const fromBackup = backup.reply(status, source, words, now, limitMs, both, toolResults, recipients, navigation, help).catch(crashed);

      return new Promise<AssistantResult>((resolve) => {
        let mainResult: AssistantResult | undefined;
        let backupResult: AssistantResult | undefined;
        let last: AssistantResult | undefined;
        let switched = false;
        let picked = false;
        const pick = (result: AssistantResult) => {
          if (picked) return;
          picked = true;
          clearTimeout(timer);
          cancel.abort();
          resolve({ ...result, ms: Date.now() - started });
        };
        const decide = () => {
          if (mainResult?.ok) return pick(mainResult);
          if (mainResult && !mainResult.ok && mainResult.reason === "refusal") return pick(mainResult);
          if (backupResult?.ok && (switched || mainResult)) return pick(backupResult);
          if (mainResult && backupResult) return pick(last!);
        };
        const timer = setTimeout(
          () => {
            switched = true;
            decide();
          },
          Math.max(0, Math.min(backupAfterMs, limitMs - BACKUP_MARGIN_MS)),
        );
        void fromMain.then((result) => {
          mainResult = last = result;
          decide();
        });
        void fromBackup.then((result) => {
          backupResult = last = result;
          decide();
        });
      });
    },
  };
}
