import { afterEach, describe, expect, it, vi } from "vitest";
import { getMotorcycleRoute } from "../src/modules/rides/routing.service.js";

const previousGoogleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY;
const previousValhallaBaseUrl = process.env.VALHALLA_BASE_URL;

function encodePolyline(points: Array<{ latitude: number; longitude: number }>): string {
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
  it("falls back to Valhalla when configured Google two-wheeler routing is unavailable", async () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-google-key";
    process.env.VALHALLA_BASE_URL = "https://valhalla.test";

    const routePoints = [
      { latitude: 3.12345, longitude: 30.87654 },
      { latitude: 3.12425, longitude: 30.87764 }
    ];
    const encodedShape = encodePolyline(routePoints);
    const requestedUrls: string[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);

      if (url === "https://routes.googleapis.com/directions/v2:computeRoutes") {
        return new Response("Google route service unavailable", { status: 503 });
      }

      if (url === "https://valhalla.test/route") {
        return new Response(JSON.stringify({
          trip: {
            status: 0,
            summary: { length: 4.25, time: 780 },
            legs: [{ shape: encodedShape }]
          }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      return new Response("Unexpected URL", { status: 404 });
    }) as typeof fetch);

    const route = await getMotorcycleRoute(
      { latitude: 3.12345, longitude: 30.87654 },
      { latitude: 3.12425, longitude: 30.87764 }
    );

    expect(requestedUrls).toEqual([
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      "https://valhalla.test/route"
    ]);
    expect(route.provider).toBe("VALHALLA_MOTORCYCLE");
    expect(route.distanceKm).toBe(4.25);
    expect(route.durationSeconds).toBe(780);
    expect(route.coordinates.length).toBeGreaterThanOrEqual(2);
    expect(route.coordinates[0]?.latitude).toBeCloseTo(routePoints[0]!.latitude, 5);
    expect(route.coordinates[1]?.longitude).toBeCloseTo(routePoints[1]!.longitude, 5);
  });
});
