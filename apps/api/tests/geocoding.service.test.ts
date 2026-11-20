import { afterEach, describe, expect, it, vi } from "vitest";
import { geocodeAruaPlace } from "../src/modules/rides/geocoding.service.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function photonFeature(longitude: number, latitude: number) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    properties: { name: "Muni University" }
  };
}

describe("Arua final-place geocoding", () => {
  it("uses Photon within the Arua boundary, identifies NAVIGO and caches the result", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe("https://photon.komoot.io/api");
      expect(url.searchParams.get("q")).toBe("Muni University, Arua, Uganda");
      expect(url.searchParams.get("bbox")).toBe("30.55,2.75,31.25,3.30");
      expect(url.searchParams.get("lat")).toBe("3.02");
      expect(url.searchParams.get("lon")).toBe("30.92");
      expect(url.searchParams.get("limit")).toBe("5");
      expect((init?.headers as Record<string, string>)["User-Agent"]).toContain("NAVIGO/1.0");

      return new Response(JSON.stringify({
        type: "FeatureCollection",
        features: [photonFeature(30.91, 3.02)]
      }), {
        status: 200,
        headers: { "Content-Type": "application/geo+json" }
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

  it("falls back to Nominatim when Photon is unavailable", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "photon.komoot.io") {
        return new Response("temporarily unavailable", { status: 503 });
      }
      expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
      expect(url.searchParams.get("format")).toBe("jsonv2");
      expect(url.searchParams.get("countrycodes")).toBe("ug");
      expect(url.searchParams.get("bounded")).toBe("1");
      return new Response(JSON.stringify([
        { lat: "3.0200", lon: "30.9100" }
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    await expect(geocodeAruaPlace("Muni University fallback test")).resolves.toEqual({
      latitude: 3.02,
      longitude: 30.91,
      description: "Muni University fallback test"
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects results outside the Arua pilot boundary", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "photon.komoot.io") {
        return new Response(JSON.stringify({
          type: "FeatureCollection",
          features: [photonFeature(32.5825, 0.3476)]
        }), {
          status: 200,
          headers: { "Content-Type": "application/geo+json" }
        });
      }
      return new Response(JSON.stringify([
        { lat: "0.3476", lon: "32.5825" }
      ]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    });
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    await expect(geocodeAruaPlace("Kampala out of area test")).rejects.toMatchObject({
      statusCode: 404,
      code: "LOCATION_NOT_FOUND"
    });
  });

  it("backs off Nominatim after a rate-limit response instead of calling it repeatedly", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "0" }
    }));
    vi.stubGlobal("fetch", fetchMock as typeof fetch);

    await expect(geocodeAruaPlace("Arua geocoder rate limit test")).rejects.toMatchObject({
      statusCode: 503,
      code: "LOCATION_PROVIDER_BUSY"
    });
    await expect(geocodeAruaPlace("Second lookup during provider cooldown")).rejects.toMatchObject({
      statusCode: 503,
      code: "LOCATION_PROVIDER_BUSY"
    });

    // The first attempt contacts Photon and Nominatim. During cooldown only
    // Photon is contacted; Nominatim is not repeatedly queried while blocked.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
