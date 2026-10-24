/** One user-initiated current-weather lookup. The GPS fix stays on the Pi and goes only to Open-Meteo. */
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

function condition(code: number): string {
  if (code === 0) return "cloudless skies";
  if (code <= 3) return "partly cloudy skies";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code >= 85 && code <= 86) return "snow showers";
  if (code >= 95 && code <= 99) return "thunderstorms";
  return "unreported conditions";
}

export async function describeCurrentWeather(latitude: number, longitude: number, signal: AbortSignal): Promise<string> {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Invalid GPS coordinates.");
  }
  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(latitude));
  url.searchParams.set("longitude", String(longitude));
  url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("forecast_days", "1");
  const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(6_000)]) });
  if (!response.ok) throw new Error(`Weather HTTP ${response.status}.`);
  const body = await response.text();
  if (body.length > 16_384) throw new Error("Weather response too large.");
  const data = JSON.parse(body) as { current?: { temperature_2m?: unknown; weather_code?: unknown; wind_speed_10m?: unknown } };
  const current = data.current;
  if (!current || typeof current.temperature_2m !== "number" || !Number.isFinite(current.temperature_2m) || current.temperature_2m < -150 || current.temperature_2m > 150 ||
      typeof current.weather_code !== "number" || !Number.isInteger(current.weather_code) || current.weather_code < 0 || current.weather_code > 99 ||
      typeof current.wind_speed_10m !== "number" || !Number.isFinite(current.wind_speed_10m) || current.wind_speed_10m < 0 || current.wind_speed_10m > 300) {
    throw new Error("Weather response missing current conditions.");
  }
  return `The latest weather estimate near you is ${Math.round(current.temperature_2m)} degrees Fahrenheit with ${condition(current.weather_code)} and wind around ${Math.round(current.wind_speed_10m)} miles per hour. Weather data from Open-Meteo.`;
}
