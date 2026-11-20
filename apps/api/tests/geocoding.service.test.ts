import { afterEach, describe, expect, it, vi } from "vitest";
import { RideError } from "../src/modules/rides/rides.service.js";
import { geocodeAruaPlace } from "../src/modules/rides/geocoding.service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Arua final-place geocoding", () => {
  it("searches within the Arua service area, identifies NAVIGO and caches the result", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
      expect(url.searchParams.get("format")).toBe("jsonv2");
      expect(url.searchParams.get("countrycodes")).toBe("ug");
      expect(url.searchParams.get("bounded")).toBe("1");
      expect(url.searchParams.get("viewbox")).toBe("30.55,3.30,31.25,2.75");
      expect(url.searchParams.get("q")).toBe("Muni University, Arua, Uganda");
      expect((init?.headers as Record<string, string>)["User-Agent"]).toContain("NAVIGO/1.0");

      return new Response(JSON.stringify([
        {
          lat: "3.0200",
          lon: "30.9100",
          display_name: "Muni University, Arua, Uganda"
        }
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    const first = await geocodeAruaPlace("Muni University");
    const cached = await geocodeAruaPlace("  muni   university  ");

    expect(first).toEqual({
      latitude: 3.02,
      longitude: 30.91,
      description: "Muni University"
    });
    expect(cached).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a clear temporary-unavailable error when Nominatim rate-limits NAVIGO", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "1" }
    })) as typeof fetch);

    await expect(geocodeAruaPlace("Arua geocoder rate limit test")).rejects.toMatchObject({
      statusCode: 503,
      code: "LOCATION_PROVIDER_BUSY"
    });
  });

  it("rejects a geocoding result outside the Arua pilot boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      { lat: "0.3476", lon: "32.5825", display_name: "Kampala, Uganda" }
    ]), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })) as typeof fetch);

    await expect(geocodeAruaPlace("Kampala out of area test")).rejects.toMatchObject({
      statusCode: 404,
      code: "LOCATION_NOT_FOUND"
    });
  });
});
