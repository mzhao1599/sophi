/**
 * "People nearby": a fixed sample for the demo, made up and kept in the app. The map under it is a real street
 * map (OpenStreetMap's tiles), but every pin on it is part of the sample: the names are invented,
 * so are the places, and their positions are fixed points around Lake Merritt in Oakland chosen for the demo.
 * No location is read, sent or stored: distances are measured from SAMPLE_AREA's starting point, never from
 * the phone or the walker. Every screen that shows it carries a dashed "Sample" tag and SAMPLE_LINE. There is
 * no community server yet.
 */

export const SAMPLE_LINE =
  "Sample people and places on a real street map. Nothing here uses GPS or anyone's real location.";

/** [latitude, longitude] of a sample pin. Made up for the demo, never a person's position. */
export type SamplePoint = readonly [number, number];

/** The real neighbourhood the sample is drawn in, and the made-up point its distances are measured from. */
export const SAMPLE_AREA = {
  name: "Lake Merritt, Oakland",
  start: [37.8098, -122.2575] as SamplePoint,
  startLabel: "Sample starting point. Distances are measured from here. It is not your location.",
} as const;

export interface SamplePerson {
  name: string;
  about: string;
  at: SamplePoint;
}

export interface SampleGroup {
  name: string;
  where: string;
  when: string;
  at: SamplePoint;
}

export interface SamplePlace {
  name: string;
  access: string;
  at: SamplePoint;
}

/** Other people who walk with a walker. */
export const SAMPLE_WALKERS: readonly SamplePerson[] = [
  { name: "Ines", about: "Walks at Lake Park most mornings", at: [37.8061, -122.2490] },
  { name: "Harold", about: "Goes to the Tuesday walking group", at: [37.8180, -122.2530] },
  { name: "June", about: "Likes the library and a slow loop", at: [37.8018, -122.2713] },
];

/** Other caretakers, for the caretaker's phone. */
export const SAMPLE_CARETAKERS: readonly SamplePerson[] = [
  { name: "Dev", about: "Looks after his dad", at: [37.8152, -122.2639] },
  { name: "Priya", about: "Home care aide, weekday mornings", at: [37.8132, -122.2442] },
];

export const SAMPLE_GROUPS: readonly SampleGroup[] = [
  { name: "Tuesday walking group", where: "Lake Park", when: "Tuesdays, 10:00", at: [37.8077, -122.2591] },
  { name: "Saturday market stroll", where: "Elm Street market", when: "Saturdays, 9:30", at: [37.8092, -122.2462] },
];

export const SAMPLE_PLACES: readonly SamplePlace[] = [
  { name: "Lakeside Library", access: "Step-free entrance and a lift", at: [37.8040, -122.2662] },
  { name: "Maple Cafe", access: "Ramp at the side door", at: [37.8139, -122.2685] },
  { name: "Lake Park loop", access: "Paved and flat, with benches", at: [37.8076, -122.2531] },
];

/** Miles from the sample's starting point, to one decimal, as the list shows it ("0.4 mi"). */
export function sampleDistance(at: SamplePoint): string {
  const rad = Math.PI / 180;
  const [lat1, lng1] = SAMPLE_AREA.start;
  const [lat2, lng2] = at;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  const miles = 2 * 3958.8 * Math.asin(Math.sqrt(a));
  return `${miles.toFixed(1)} mi`;
}
