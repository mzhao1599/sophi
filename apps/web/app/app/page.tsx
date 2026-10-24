import { PhoneApp } from "@/components/PhoneApp";
import type { PhoneRole } from "@/lib/phoneApi";

/**
 * /app: the two-phone app (her own phone in simple mode, or a caretaker's). `?preview=rose` or
 * `?preview=maya` (development only) runs it on the in-memory fake, labelled "Preview" on every screen;
 * it is never the stage path.
 */
export default async function AppPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { preview } = await searchParams;
  const roles: Record<string, PhoneRole> = { rose: "walker_user", maya: "caregiver" };
  const role = process.env.NODE_ENV !== "production" && typeof preview === "string" ? (roles[preview] ?? null) : null;
  return <PhoneApp preview={role} />;
}
