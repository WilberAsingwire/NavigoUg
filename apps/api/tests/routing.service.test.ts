import { afterEach, describe, expect, it, vi } from "vitest";
import { getMotorcycleRoute } from "../src/modules/rides/routing.service.js";

const previousGoogleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
const previousValhallaBaseUrl = process.env.VALHALLA_BASE_URL;

function encodePolyline6(points: Array<{ latitude: number; longitude: number }>): string {
  let previousLatitude = 0;
  let previousLongitude = 0;
  let encoded = "";

  const encodeValue = (delta: number): string => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    let result = "";
    while (value >= 0x20) {
      result += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    return result + String.fromCharCode(value + 63);
  };

  for (const point of points) {
    const latitude = Math.round(point.latitude * 1_000_000);
    const longitude = Math.round(point.longitude * 1_000_000);
    encoded += encodeValue(latitude - previousLatitude);
    encoded += encodeValue(longitude - previousLongitude);
    previousLatitude = latitude;
    previousLongitude = longitude;
  }

  return encoded;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousGoogleMapsApiKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
  else process.env.GOOGLE_MAPS_API_KEY = previousGoogleMapsApiKey;
  if (previousValhallaBaseUrl === undefined) delete process.env.VALHALLA_BASE_URL;
  else process.env.VALHALLA_BASE_URL = previousValhallaBaseUrl;
});

describe("motorcycle road routing", () => {
  it("requests Valhalla motorcycle routes using supported kilometre units", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    process.env.VALHALLA_BASE_URL = "https://valhalla.test";

    const points = [
      { latitude: 3.0200, longitude: 30.9100 },
      { latitude: 3.0300, longitude: 30.9200 }
    ];
    let valhallaRequestBody: Record<string, unknown> | undefined;

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://valhalla.test/route");
      valhallaRequestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        trip: {
          status: 0,
          summary: { length: 3.75, time: 840 },
          legs: [{ shape: encodePolyline6(points) }]
        }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch);

    const route = await getMotorcycleRoute(points[0]!, points[1]!);

    expect(valhallaRequestBody).toMatchObject({
      costing: "motorcycle",
      units: "km"
    });
    expect(route.provider).toBe("VALHALLA_MOTORCYCLE");
    expect(route.distanceKm).toBe(3.75);
    expect(route.durationSeconds).toBe(840);
    expect(route.coordinates).toHaveLength(2);
  });
});
