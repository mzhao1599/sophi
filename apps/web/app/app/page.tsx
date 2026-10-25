import { PhoneApp, START_SCREENS, type StartScreen } from "@/components/PhoneApp";
import type { PhoneRole } from "@/lib/phoneApi";

/**
 * /app: the two-phone app (her own phone in simple mode, or a caretaker's). `?preview=rose` or
 * `?preview=maya` (development only) runs it on the in-memory fake, labelled "Preview" on every screen;
 * it is never the stage path. With a preview, `&caretakers=0|1|2` sets how many caretakers the fake circle has
 * and `&location=1` turns her sharing on with a made-up fix, and `&route=1` puts her on the sample's route.
 * `?screen=messages`, `walker` or `nearby` opens the linked phone on that screen (for the stage: Rose's thread,
 * Maya's walker); anything else opens the usual first screen.
 */
export default async function AppPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { preview, caretakers, location, route, screen } = await searchParams;
  const roles: Record<string, PhoneRole> = { rose: "walker_user", maya: "caregiver" };
  const role = process.env.NODE_ENV !== "production" && typeof preview === "string" ? (roles[preview] ?? null) : null;
  const count = typeof caretakers === "string" && /^[0-2]$/.test(caretakers) ? Number(caretakers) : undefined;
  const start = typeof screen === "string" && (START_SCREENS as readonly string[]).includes(screen) ? (screen as StartScreen) : undefined;
  return <PhoneApp preview={role} start={start} previewOptions={role ? { caretakers: count, location: location === "1", route: route === "1" } : {}} />;
}
