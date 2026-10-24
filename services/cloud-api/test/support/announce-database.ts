import { SKIP_MESSAGE, localStack } from "./local-supabase";

export default function announceDatabase() {
  console.log(localStack ? `Running the Supabase tests against ${localStack.url}.` : SKIP_MESSAGE);
}
