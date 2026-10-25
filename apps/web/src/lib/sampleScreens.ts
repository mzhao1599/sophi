import { PRESET_REPLIES } from "@/lib/phoneApi";

/**
 * The two sample phone screens for the stage (/sample/caretaker and /sample/rose): fixed, made-up data,
 * shown for a glance while the presenter talks. Nothing here is read from a walker, a phone or the server,
 * and each screen carries one "Sample" tag. What the real app does today is in docs/subsystems/web-and-onboarding.md
 * ("Sample screens"): Maya's real phone shows Rose's walker's last GPS fix only while Rose shares it, and
 * no route; the route view here is a sample of where that could go.
 */

/** [latitude, longitude]. */
export type SamplePoint = readonly [number, number];

/**
 * A walking route by Lake Merritt, Oakland: OpenStreetMap's foot router (routing.openstreetmap.de) from the
 * simulator's starting point to the Lake Merritt Boating Center, fetched once on 2026-10-24 (773 m). Copied
 * from DEMO_ROUTE in packages/walker-screen/src/fixtures.ts. A drawn route, not a recorded walk. Map data
 * © OpenStreetMap contributors.
 */
export const SAMPLE_ROUTE: readonly SamplePoint[] = [
  [37.809811, -122.257641], [37.809945, -122.25809], [37.809971, -122.258176], [37.809958, -122.258182], [37.809851, -122.258235],
  [37.809485, -122.258412], [37.80946, -122.258426], [37.80943, -122.258342], [37.809314, -122.258407], [37.809209, -122.258465],
  [37.809193, -122.258474], [37.809139, -122.258333], [37.809083, -122.258339], [37.809025, -122.258344], [37.808969, -122.258339],
  [37.808918, -122.258329], [37.808851, -122.258311], [37.80877, -122.258284], [37.808679, -122.258237], [37.808601, -122.258179],
  [37.808364, -122.257952], [37.808352, -122.257939], [37.808285, -122.257973], [37.808089, -122.258074], [37.807946, -122.258143],
  [37.807597, -122.258332], [37.807481, -122.258334], [37.807462, -122.258295], [37.807366, -122.258094], [37.807303, -122.257992],
  [37.807203, -122.257828], [37.807125, -122.257572], [37.80706, -122.257348], [37.807045, -122.257304], [37.807023, -122.257239],
  [37.806943, -122.257039], [37.806895, -122.256946], [37.806854, -122.256879], [37.806817, -122.256836], [37.806757, -122.256786],
  [37.806748, -122.256792], [37.806722, -122.25671], [37.806699, -122.256639], [37.806686, -122.256596], [37.806655, -122.256619],
  [37.80664, -122.25663], [37.806628, -122.256641], [37.806563, -122.256696], [37.806453, -122.256755], [37.806337, -122.256817],
  [37.80628, -122.256821], [37.806159, -122.256842], [37.806048, -122.256822], [37.805987, -122.256794], [37.805926, -122.256865],
  [37.805908, -122.256896], [37.805889, -122.256952], [37.805836, -122.256966], [37.805801, -122.256976], [37.805762, -122.256992],
  [37.805723, -122.257011], [37.805679, -122.257042], [37.805634, -122.25708], [37.805597, -122.257119], [37.805548, -122.257184],
  [37.805525, -122.257226], [37.805513, -122.257238], [37.805497, -122.257249], [37.805468, -122.257264], [37.805436, -122.257272],
  [37.805379, -122.257289], [37.805355, -122.257262], [37.805299, -122.257364], [37.80522, -122.257582], [37.805086, -122.257848],
];

export const SAMPLE_DESTINATION = "Lake Merritt Boating Center";
export const SAMPLE_DESTINATION_SHORT = "Boating Center";

/** How far along the route the sample puts Rose, in metres. */
const WALKED_M = 470;
/** A slow walker pace for the time left, made up for the sample (about 2.9 km/h). */
const PACE_M_PER_S = 0.8;

function metres(a: SamplePoint, b: SamplePoint): number {
  const r = Math.PI / 180;
  const x = (b[1] - a[1]) * r * Math.cos(((a[0] + b[0]) / 2) * r);
  const y = (b[0] - a[0]) * r;
  return 6371000 * Math.hypot(x, y);
}

export function routeLength(route: readonly SamplePoint[]): number {
  let d = 0;
  for (let i = 1; i < route.length; i++) d += metres(route[i - 1]!, route[i]!);
  return d;
}

/** The route split where she is: the part behind her, the part ahead, both including her point. */
export function splitRoute(route: readonly SamplePoint[], walkedM: number) {
  let d = 0;
  for (let i = 1; i < route.length; i++) {
    d += metres(route[i - 1]!, route[i]!);
    if (d >= walkedM) return { behind: route.slice(0, i + 1), ahead: route.slice(i), at: route[i]! };
  }
  return { behind: route, ahead: route.slice(-1), at: route[route.length - 1]! };
}

const split = splitRoute(SAMPLE_ROUTE, WALKED_M);
const leftM = routeLength(split.ahead);

export const SAMPLE_WALK = {
  ...split,
  start: SAMPLE_ROUTE[0]!,
  end: SAMPLE_ROUTE[SAMPLE_ROUTE.length - 1]!,
  /** Rounded to 10 m, as a phone would say it. */
  leftM: Math.round(leftM / 10) * 10,
  leftMin: Math.max(1, Math.round(leftM / PACE_M_PER_S / 60)),
};

export interface SampleMessage {
  from: "maya" | "rose";
  text: string;
  at: string;
}

/**
 * Rose and Maya's thread, oldest first. Maya types (at most 30 characters, as the real app allows); Rose
 * only taps one of her three replies, so her lines are PRESET_REPLIES. The story matches the map: Maya asks
 * her to meet at the Boating Center, and Rose is on her way there.
 */
export const SAMPLE_THREAD: readonly SampleMessage[] = [
  { from: "maya", text: "Dinner at six. I'll get you.", at: "5:31 PM" },
  { from: "rose", text: PRESET_REPLIES.okay, at: "5:32 PM" },
  { from: "maya", text: "Meet me at the Boating Center?", at: "5:44 PM" },
  { from: "rose", text: PRESET_REPLIES.on_my_way, at: "5:45 PM" },
];
