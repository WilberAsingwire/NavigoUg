import { RideError } from "./rides.service.js";

export type AruaGeocodedLocation = {
  latitude: number;
  longitude: number;
  description: string;
};

type NominatimResult = {
  lat?: string;
  lon?: string;
  display_name?: string;
};

const ARUA_BOUNDS = {
  minLongitude: 30.55,
  maxLongitude: 31.25,
  minLatitude: 2.75,
  maxLatitude: 3.30
} as const;

const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org/search";
const NOMINATIM_MIN_INTERVAL_MS = 1_100;
const NOMINATIM_TIMEOUT_MS = 12_000;
const GEOCODE_CACHE_TTL_MS = 30 * 60 * 1000;
const GEOCODE_CACHE_MAX_ENTRIES = 1_000;

const geocodeCache = new Map<string, { expiresAt: number; location: AruaGeocodedLocation }>();
const inFlightLookups = new Map<string, Promise<AruaGeocodedLocation>>();

let nominatimQueue: Promise<void> = Promise.resolve();
let nextNominatimRequestAt = 0;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForNominatimSlot(): Promise<void> {
  const remaining = nextNominatimRequestAt - Date.now();
  if (remaining > 0) await wait(remaining);
  nextNominatimRequestAt = Date.now() + NOMINATIM_MIN_INTERVAL_MS;
}

function scheduleNominatimRequest<T>(operation: () => Promise<T>): Promise<T> {
  const scheduled = nominatimQueue.then(operation);
  nominatimQueue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

function isInsideArua(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= ARUA_BOUNDS.minLatitude &&
    latitude <= ARUA_BOUNDS.maxLatitude &&
    longitude >= ARUA_BOUNDS.minLongitude &&
    longitude <= ARUA_BOUNDS.maxLongitude
  );
}

async function lookupWithNominatim(query: string): Promise<AruaGeocodedLocation> {
  return scheduleNominatimRequest(async () => {
    await waitForNominatimSlot();

    const url = new URL(NOMINATIM_BASE_URL);
    url.searchParams.set("q", /uganda/i.test(query) ? query : `${query}, Arua, Uganda`);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("countrycodes", "ug");
    // Nominatim viewbox order: left, top, right, bottom.
    url.searchParams.set("viewbox", "30.55,3.30,31.25,2.75");
    url.searchParams.set("bounded", "1");
    url.searchParams.set("addressdetails", "1");

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "Accept-Language": "en",
          "User-Agent": "NAVIGO/1.0 (+https://github.com/WilberAsingwire/NavigoUg)"
        },
        signal: AbortSignal.timeout(NOMINATIM_TIMEOUT_MS)
      });
    } catch (error) {
      console.warn("[NAVIGO geocoding] Nominatim request failed", {
        reason: error instanceof Error ? error.name : "unknown"
      });
      throw new RideError(
        503,
        "LOCATION_PROVIDER_UNAVAILABLE",
        "Arua place lookup is temporarily unavailable. Please try again in a moment."
      );
    }

    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      console.warn("[NAVIGO geocoding] Nominatim temporarily rejected a lookup", {
        status: response.status,
        retryAfter: response.headers.get("retry-after")
      });
      throw new RideError(
        503,
        "LOCATION_PROVIDER_BUSY",
        "Arua place lookup is busy. Please wait a moment and try again."
      );
    }

    if (!response.ok) {
      console.warn("[NAVIGO geocoding] Nominatim rejected a lookup", {
        status: response.status
      });
      throw new RideError(
        503,
        "LOCATION_PROVIDER_UNAVAILABLE",
        "Arua place lookup could not be completed. Please try again."
      );
    }

    let results: NominatimResult[];
    try {
      results = await response.json() as NominatimResult[];
    } catch {
      throw new RideError(
        503,
        "LOCATION_PROVIDER_INVALID_RESPONSE",
        "Arua place lookup returned an invalid response. Please try again."
      );
    }

    const candidates = (Array.isArray(results) ? results : []).flatMap((result) => {
      const latitude = Number(result.lat);
      const longitude = Number(result.lon);
      if (!isInsideArua(latitude, longitude)) return [];
      return [{ latitude, longitude }];
    });

    const first = candidates[0];
    if (!first) {
      throw new RideError(
        404,
        "LOCATION_NOT_FOUND",
        `We couldn't find "${query}" inside NAVIGO's current Arua service area. Try a nearby landmark or one of the suggested places.`
      );
    }

    return {
      ...first,
      description: query
    };
  });
}

/**
 * Resolve a customer-submitted place once, after the customer presses the
 * route-preview action. This endpoint is deliberately not used for
 * search-as-you-type/autocomplete. Results are cached and all external
 * Nominatim requests are serialized at <= 1 request per second for the
 * entire NAVIGO API instance.
 */
export async function geocodeAruaPlace(value: string): Promise<AruaGeocodedLocation> {
  const query = value.trim().replace(/\s+/g, " ");
  if (query.length < 3 || query.length > 160) {
    throw new RideError(
      400,
      "INVALID_LOCATION_QUERY",
      "Enter a location name between 3 and 160 characters."
    );
  }

  const key = query.toLocaleLowerCase("en");
  const cached = geocodeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.location;
  if (cached) geocodeCache.delete(key);

  const existing = inFlightLookups.get(key);
  if (existing) return existing;

  const pending = lookupWithNominatim(query);
  inFlightLookups.set(key, pending);
  try {
    const location = await pending;
    if (geocodeCache.size >= GEOCODE_CACHE_MAX_ENTRIES) {
      const oldestKey = geocodeCache.keys().next().value;
      if (oldestKey) geocodeCache.delete(oldestKey);
    }
    geocodeCache.set(key, {
      expiresAt: Date.now() + GEOCODE_CACHE_TTL_MS,
      location
    });
    return location;
  } finally {
    inFlightLookups.delete(key);
  }
}
