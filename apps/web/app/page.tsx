import { connection } from "next/server";
import { openingQuestion } from "@walker/cloud-api";
import { DemoScreen } from "@/components/DemoScreen";
import { engineKind, screenAccess } from "@/server/onboarding";

/**
 * The demo: one page with the guided chat and the walker. Rendered per request, because the data
 * notice under the text box depends on the server's settings (whether a model reads the answers) and
 * on who is signed in.
 */
export default async function Home() {
  await connection();
  return <DemoScreen opening={openingQuestion()} agent={engineKind === "agent"} {...await screenAccess()} />;
}
