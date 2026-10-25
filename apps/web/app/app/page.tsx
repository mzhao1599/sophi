import { PhoneApp } from "@/components/PhoneApp";
import type { PhoneRole } from "@/lib/phoneApi";

/**
 * /app: the two-phone app (her own phone in simple mode, or a caretaker's). `?preview=rose` or
 * `?preview=maya` (development only) runs it on the in-memory fake, labelled "Preview" on every screen;
 * it is never the stage path. With a preview, `&caretakers=0|1|2` sets how many caretakers the fake circle has
 * and `&location=1` turns her sharing on with a made-up fix.
 */
export default async function AppPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { preview, caretakers, location } = await searchParams;
  const roles: Record<string, PhoneRole> = { rose: "walker_user", maya: "caregiver" };
  const role = process.env.NODE_ENV !== "production" && typeof preview === "string" ? (roles[preview] ?? null) : null;
  const count = typeof caretakers === "string" && /^[0-2]$/.test(caretakers) ? Number(caretakers) : undefined;
  return <PhoneApp preview={role} previewOptions={role ? { caretakers: count, location: location === "1" } : {}} />;
}
