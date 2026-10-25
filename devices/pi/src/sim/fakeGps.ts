import type { PlaceReading } from "../location";
import type { WeatherReading } from "../weather";

/**
 * `walker simulate --gps`: a SIMULATED GPS receiver with a fixed, made-up fix, and SIMULATED weather and address
 * lookups that say so, so a weather or location question (and `show_on_screen`) runs with no receiver and no
 * internet. Nothing here is a real position, forecast or address. The simulated position is never shared:
 * `current()` is always null, so no heartbeat carries it, even with location sharing on.
 */
export class SimulatedGps {
  readonly simulated = true;

  connected(): boolean {
    return true;
  }

  setEnabled(): void {}

  current(): null {
    return null;
  }

  async onDemand(): Promise<{ status: "fix"; latitude: number; longitude: number }> {
    // Made up; only the simulated lookups below ever see it.
    return { status: "fix", latitude: 0, longitude: 0 };
  }

  stop(): void {}
}

/** The simulated lookups: fixed sample values, worded so nobody takes them for a real forecast or address. */
export const SIMULATED_LOOKUPS = {
  async weather(): Promise<WeatherReading> {
    return {
      text: "Simulated weather, not a real forecast: 64 degrees Fahrenheit with partly cloudy skies and wind around 8 miles per hour.",
      temperature_f: 64,
      conditions: "partly cloudy skies",
      wind_mph: 8,
    };
  },
  async place(): Promise<PlaceReading> {
    return { text: "Simulated position, not a real place: your GPS puts you near 100 Sample Street, Simulated City.", place: "100 Sample Street, Simulated City" };
  },
};
