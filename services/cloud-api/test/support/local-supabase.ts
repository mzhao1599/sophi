import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The local Supabase stack, when the tests were started with `pnpm test:db` (which reads the URL and
 * keys from `supabase status`). Null otherwise, and the database tests skip with a message saying so.
 * These tests create and delete users, so a URL that isn't on this machine is refused outright.
 */
export interface LocalStack {
  url: string;
  publishableKey: string;
  secretKey: string;
}

export const localStack: LocalStack | null = (() => {
  const url = process.env.SUPABASE_TEST_URL?.trim();
  const publishableKey = process.env.SUPABASE_TEST_PUBLISHABLE_KEY?.trim();
  const secretKey = process.env.SUPABASE_TEST_SECRET_KEY?.trim();
  if (!url || !publishableKey || !secretKey) return null;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error(`SUPABASE_TEST_URL must be a local stack (127.0.0.1 or localhost), not ${new URL(url).host}: these tests create and delete users.`);
  }
  return { url, publishableKey, secretKey };
})();

export const SKIP_MESSAGE =
  "Skipping the Supabase tests: no local stack. Start Docker, run `pnpm supabase start`, then `pnpm test:db`.";

const OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export function adminClient(stack: LocalStack): SupabaseClient {
  return createClient(stack.url, stack.secretKey, OPTIONS);
}

/** A client with only the public (publishable) key and no session: what any visitor's browser has. */
export function anonClient(stack: LocalStack): SupabaseClient {
  return createClient(stack.url, stack.publishableKey, OPTIONS);
}

export interface TestUser {
  id: string;
  email: string;
  /** A publishable-key client signed in as this user, so row-level security applies to it. */
  client: SupabaseClient;
}

/**
 * Creates a throwaway user on the local stack and signs them in without a password: the admin API
 * makes a magic link, and its token is redeemed the way the /auth/confirm route does. The address
 * uses the reserved .test domain, so nothing could ever be delivered.
 */
export async function createTestUser(stack: LocalStack, label: string): Promise<TestUser> {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@walker-tests.test`;
  const link = await adminClient(stack).auth.admin.generateLink({ type: "magiclink", email });
  if (link.error || !link.data.user) throw new Error(`Couldn't create test user: ${link.error?.message}`);
  const client = anonClient(stack);
  const verified = await client.auth.verifyOtp({ type: "email", token_hash: link.data.properties.hashed_token });
  if (verified.error || !verified.data.session) throw new Error(`Couldn't sign in test user: ${verified.error?.message}`);
  return { id: link.data.user.id, email, client };
}

/** Deleting a user cascades to everything they own, which is also what account deletion relies on. */
export async function deleteTestUsers(stack: LocalStack, users: TestUser[]) {
  const admin = adminClient(stack);
  for (const user of users) await admin.auth.admin.deleteUser(user.id);
}
