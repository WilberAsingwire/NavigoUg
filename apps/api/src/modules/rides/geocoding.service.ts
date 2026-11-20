import { RideError } from "./rides.service.js";

export type AruaGeocodedLocation = {
  latitude: number;
  longitude: number;
  description: string;
};

type NominatimResult = {
  lat?: string;
  lon?: string;
};

type PhotonFeature = {
  geometry?: { coordinates?: unknown };
};

type LookupAttempt = {
  location: AruaGeocodedLocation | null;
  unavailable: boolean;
  busy?: boolean;
};

const ARUA_BOUNDS = {
  minLongitude: 30.55,
  maxLongitude: 31.25,
  minLatitude: 2.75,
  maxLatitude: 3.30
} as const;

const PHOTON_BASE_URL = (
  process.env.PHOTON_BASE_URL || "https://photon.komoot.io/api"
).replace(/\/+$/, "");
const NOMINATIM_BASE_URL = (
  process.env.NOMINATIM_BASE_URL || "https://nominatim.openstreetmap.org/search"
).replace(/\/+$/, "");
// Photon is a public demo endpoint too, so keep its usage modest. Nominatim's
// public service has a strict one-request-per-second application-wide ceiling.
const PUBLIC_GEOCODER_MIN_INTERVAL_MS = process.env.NODE_ENV === "test" ? 0 : 1_100;
const PHOTON_TIMEOUT_MS = 8_000;
const NOMINATIM_TIMEOUT_MS = 12_000;
const GEOCODE_CACHE_TTL_MS = 30 * 60 * 1000;
const GEOCODE_CACHE_MAX_ENTRIES = 1_000;

const geocodeCache = new Map<string, { expiresAt: number; location: AruaGeocodedLocation }>();
const inFlightLookups = new Map<string, Promise<AruaGeocodedLocation>>();

let photonQueue: Promise<void> = Promise.resolve();
let nominatimQueue: Promise<void> = Promise.resolve();
let nextPhotonRequestAt = 0;
let nextNominatimRequestAt = 0;
let nominatimBlockedUntil = 0;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForSlot(nextRequestAt: number): Promise<void> {
  const remaining = nextRequestAt - Date.now();
  if (remaining > 0) await wait(remaining);
}

function schedulePhotonRequest<T>(operation: () => Promise<T>): Promise<T> {
  const scheduled = photonQueue.then(async () => {
    await waitForSlot(nextPhotonRequestAt);
    nextPhotonRequestAt = Date.now() + PUBLIC_GEOCODER_MIN_INTERVAL_MS;
    return operation();
  });
  photonQueue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

function scheduleNominatimRequest<T>(operation: () => Promise<T>): Promise<T> {
  const scheduled = nominatimQueue.then(async () => {
    await waitForSlot(nextNominatimRequestAt);
    nextNominatimRequestAt = Date.now() + PUBLIC_GEOCODER_MIN_INTERVAL_MS;
    return operation();
  });
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

function aruaLocation(latitude: number, longitude: number, query: string): AruaGeocodedLocation | null {
  if (!isInsideArua(latitude, longitude)) return null;
  return { latitude, longitude, description: query };
}

function retryDelayMs(value: string | null): number {
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(60_000, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(60_000, date - Date.now()) : 60_000;
}

async function lookupWithPhoton(query: string): Promise<LookupAttempt> {
  return schedulePhotonRequest(async () => {
    const url = new URL(PHOTON_BASE_URL);
    url.searchParams.set("q", /uganda/i.test(query) ? query : `${query}, Arua, Uganda`);
    url.searchParams.set("limit", "5");
    url.searchParams.set("lang", "en");
    url.searchParams.set("lat", "3.02");
    url.searchParams.set("lon", "30.92");
    // Photon bbox order: min longitude, min latitude, max longitude, max latitude.
    url.searchParams.set("bbox", "30.55,2.75,31.25,3.30");

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/geo+json, application/json",
          "Accept-Language": "en",
          "User-Agent": "NAVIGO/1.0 (+https://github.com/WilberAsingwire/NavigoUg)"
        },
        signal: AbortSignal.timeout(PHOTON_TIMEOUT_MS)
      });
    } catch (error) {
      console.warn("[NAVIGO geocoding] Photon request failed", {
        reason: error instanceof Error ? error.name : "unknown"
      });
      return { location: null, unavailable: true };
    }

    if (!response.ok) {
      const busy = response.status === 403 || response.status === 429 || response.status >= 500;
      console.warn("[NAVIGO geocoding] Photon rejected a lookup", { status: response.status });
      return { location: null, unavailable: true, busy };
    }

    let results: { features?: PhotonFeature[] };
    try {
      results = await response.json() as { features?: PhotonFeature[] };
    } catch {
      console.warn("[NAVIGO geocoding] Photon returned invalid JSON");
      return { location: null, unavailable: true };
    }

    const features = Array.isArray(results?.features) ? results.features : [];
    for (const feature of features) {
      const coordinates = feature.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
      const longitude = Number(coordinates[0]);
      const latitude = Number(coordinates[1]);
      const location = aruaLocation(latitude, longitude, query);
      if (location) return { location, unavailable: false };
    }

    return { location: null, unavailable: false };
  });
}

async function lookupWithNominatim(query: string): Promise<LookupAttempt> {
  return scheduleNominatimRequest(async () => {
    if (Date.now() < nominatimBlockedUntil) {
      return { location: null, unavailable: true, busy: true };
    }

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
      return { location: null, unavailable: true };
    }

    if (response.status === 403 || response.status === 429) {
      nominatimBlockedUntil = Math.max(
        nominatimBlockedUntil,
        Date.now() + retryDelayMs(response.headers.get("retry-after"))
      );
      console.warn("[NAVIGO geocoding] Nominatim rate-limited NAVIGO; fallback cooldown enabled", {
        status: response.status,
        retryAfter: response.headers.get("retry-after")
      });
      return { location: null, unavailable: true, busy: true };
    }

    if (response.status >= 500 || !response.ok) {
      console.warn("[NAVIGO geocoding] Nominatim rejected a lookup", { status: response.status });
      return { location: null, unavailable: true, busy: response.status >= 500 };
    }

    let results: NominatimResult[];
    try {
      results = await response.json() as NominatimResult[];
    } catch {
      console.warn("[NAVIGO geocoding] Nominatim returned invalid JSON");
      return { location: null, unavailable: true };
    }

    for (const result of Array.isArray(results) ? results : []) {
      const latitude = Number(result.lat);
      const longitude = Number(result.lon);
      const location = aruaLocation(latitude, longitude, query);
      if (location) return { location, unavailable: false };
    }

    return { location: null, unavailable: false };
  });
}

async function lookupAruaPlace(query: string): Promise<AruaGeocodedLocation> {
  // Use Photon first so a temporary Nominatim block does not stop every fare
  // preview. Nominatim remains a slower secondary provider for missing places.
  const photon = await lookupWithPhoton(query);
  if (photon.location) return photon.location;

  const nominatim = await lookupWithNominatim(query);
  if (nominatim.location) return nominatim.location;

  if (photon.unavailable || nominatim.unavailable) {
    const busy = photon.busy || nominatim.busy;
    throw new RideError(
      503,
      busy ? "LOCATION_PROVIDER_BUSY" : "LOCATION_PROVIDER_UNAVAILABLE",
      busy
        ? "Arua place lookup is temporarily busy. Please try again in a moment."
        : "Arua place lookup is temporarily unavailable. Please try again in a moment."
    );
  }

  throw new RideError(
    404,
    "LOCATION_NOT_FOUND",
    `We couldn't find "${query}" inside NAVIGO's current Arua service area. Try a nearby landmark or one of the suggested places.`
  );
}

/**
 * Resolve a customer-submitted place once, after the customer presses the
 * route-preview action. This endpoint is deliberately not used for
 * search-as-you-type/autocomplete. Successful results are cached and repeated
 * external lookups are coalesced. Both public providers are rate-spaced.
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

  const pending = lookupAruaPlace(query);
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
