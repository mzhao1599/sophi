import type { SupabaseClient } from "@supabase/supabase-js";
import { DeviceConfigurationSchema, type DeviceConfiguration } from "@walker/contracts";
import { SupabaseStoreError } from "./supabase-store";

/**
 * Reads for a signed-in user's account pages. Each takes the client carrying that user's own access
 * token, so row-level security limits it to their rows; nothing here uses the secret key. Deleting
 * a setup goes through OnboardingService.remove, which deletes its session and, with it, the setup.
 */

export interface SavedSetup {
  /** The onboarding session the setup was confirmed in; deleting that session deletes the setup. */
  session_id: string;
  configuration: DeviceConfiguration;
}

/** The user's confirmed setups, newest first. A row that doesn't match the contract is left out. */
export async function listSetups(user: SupabaseClient): Promise<SavedSetup[]> {
  const { data, error } = await user
    .from("device_configurations")
    .select("session_id, configuration")
    .order("configuration_version", { ascending: false });
  if (error) throw new SupabaseStoreError("list setups", error.code);
  const rows = (data ?? []) as { session_id: string; configuration: unknown }[];
  // Owners can write their own rows directly, so a row is checked before it is shown.
  return rows.flatMap((row) => {
    const parsed = DeviceConfigurationSchema.safeParse(row.configuration);
    return parsed.success ? [{ session_id: row.session_id, configuration: parsed.data }] : [];
  });
}

/** The user's most recently changed setup that isn't finished or expired, so another device can carry on with it. */
export async function latestOpenSessionId(user: SupabaseClient, now: Date = new Date()): Promise<string | null> {
  const { data, error } = await user
    .from("onboarding_sessions")
    .select("id")
    .neq("state", "confirmed")
    .gt("expires_at", now.toISOString())
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string }>();
  if (error) throw new SupabaseStoreError("find an open setup", error.code);
  return data?.id ?? null;
}
