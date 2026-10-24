/**
 * "People nearby": a fixed sample for the demo, made up and kept in the app. No location is read, sent or
 * stored: the distances are part of the sample, the names are invented, and so are the places. Every
 * screen that shows it carries a dashed "Sample" tag and SAMPLE_LINE. There is no community server yet.
 */

export const SAMPLE_LINE = "Sample people for the demo. Sophi doesn't share anyone's location.";

export interface SamplePerson {
  name: string;
  about: string;
  distance: string;
}

export interface SampleGroup {
  name: string;
  where: string;
  when: string;
}

export interface SamplePlace {
  name: string;
  access: string;
  distance: string;
}

/** Other people who walk with a walker. */
export const SAMPLE_WALKERS: readonly SamplePerson[] = [
  { name: "Ines", about: "Walks at Lake Park most mornings", distance: "0.4 mi" },
  { name: "Harold", about: "Goes to the Tuesday walking group", distance: "0.7 mi" },
  { name: "June", about: "Likes the library and a slow loop", distance: "1.1 mi" },
];

/** Other caretakers, for the caretaker's phone. */
export const SAMPLE_CARETAKERS: readonly SamplePerson[] = [
  { name: "Dev", about: "Looks after his dad", distance: "0.6 mi" },
  { name: "Priya", about: "Home care aide, weekday mornings", distance: "0.9 mi" },
];

export const SAMPLE_GROUPS: readonly SampleGroup[] = [
  { name: "Tuesday walking group", where: "Lake Park", when: "Tuesdays, 10:00" },
  { name: "Saturday market stroll", where: "Elm Street market", when: "Saturdays, 9:30" },
];

export const SAMPLE_PLACES: readonly SamplePlace[] = [
  { name: "Lakeside Library", access: "Step-free entrance and a lift", distance: "0.5 mi" },
  { name: "Maple Cafe", access: "Ramp at the side door", distance: "0.8 mi" },
  { name: "Lake Park loop", access: "Paved and flat, with benches", distance: "0.3 mi" },
];
