import type { AnswerProposalResponse, DeviceAskForHelpRequest, HelpView, DeviceMessagesResponse, DeviceSendMessageRequest, DeviceTurnRequest, HeartbeatRequest, HeartbeatResponse, WalkerConfiguration, WalkerTurnResponse } from "@walker/contracts";
import { CloudError, toCloudError, type CloudClient } from "../cloud/client";

/**
 * The simulator's network switch: its `o` and `g` keys act on the walker's own requests to any server, the
 * fake cloud or a real one, so the offline beat can be shown on a Mac. `down` fails every request at once as
 * unreachable; `hang` leaves it unanswered until the caller's deadline (or cancel) ends it. Simulator only.
 */
export type NetworkMode = "up" | "down" | "hang";

export class NetworkSwitch {
  mode: NetworkMode = "up";
}

export class SwitchableCloudClient implements CloudClient {
  constructor(
    private readonly inner: CloudClient,
    private readonly network: NetworkSwitch,
  ) {}

  private gate<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    if (this.network.mode === "down") return Promise.reject(new CloudError("unreachable", "Network down (simulator switch)."));
    if (this.network.mode === "hang") {
      return new Promise<T>((_, reject) => {
        const onAbort = () => reject(toCloudError(signal.reason, signal));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
    }
    return call();
  }

  heartbeat(body: HeartbeatRequest, signal: AbortSignal): Promise<HeartbeatResponse> {
    return this.gate(signal, () => this.inner.heartbeat(body, signal));
  }

  configuration(signal: AbortSignal): Promise<WalkerConfiguration> {
    return this.gate(signal, () => this.inner.configuration(signal));
  }

  turn(body: DeviceTurnRequest, signal: AbortSignal): Promise<WalkerTurnResponse> {
    return this.gate(signal, () => this.inner.turn(body, signal));
  }

  sendMessage(body: DeviceSendMessageRequest, signal: AbortSignal): Promise<{ sent: true }> {
    return this.gate(signal, () => this.inner.sendMessage(body, signal));
  }

  incomingMessages(signal: AbortSignal): Promise<DeviceMessagesResponse> {
    return this.gate(signal, () => this.inner.incomingMessages(signal));
  }

  answerProposal(proposalId: string, answer: "confirm" | "decline", signal: AbortSignal): Promise<AnswerProposalResponse> {
    return this.gate(signal, () => this.inner.answerProposal(proposalId, answer, signal));
  }

  askForHelp(body: DeviceAskForHelpRequest, signal: AbortSignal): Promise<HelpView> {
    return this.gate(signal, () => this.inner.askForHelp(body, signal));
  }

  helpStatus(signal: AbortSignal): Promise<HelpView | null> {
    return this.gate(signal, () => this.inner.helpStatus(signal));
  }

  helpOkay(helpId: string, signal: AbortSignal): Promise<HelpView> {
    return this.gate(signal, () => this.inner.helpOkay(helpId, signal));
  }
}
