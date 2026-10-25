import { connection } from "next/server";
import { openingQuestion } from "@walker/cloud-api";
import { DemoScreen } from "@/components/DemoScreen";
import { agentName, screenAccess } from "@/server/onboarding";
import { onboardingVoice } from "@/server/voice";

/**
 * The demo: one page with the guided chat and the walker. Rendered per request, because the data
 * notice under the text box depends on the server's settings (whether a model reads the answers) and
 * on who is signed in, and the microphone shows only when the server has Cartesia.
 */
export default async function Home() {
  await connection();
  return <DemoScreen opening={openingQuestion()} agentName={agentName} voice={onboardingVoice() !== null} {...await screenAccess()} />;
}
