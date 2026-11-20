export type RouteCoordinate = {
  latitude: number;
  longitude: number;
};

export type MotorcycleRoute = {
  distanceKm: number;
  durationSeconds: number;
  coordinates: RouteCoordinate[];
  provider: "GOOGLE_TWO_WHEELER" | "VALHALLA_MOTORCYCLE";
};

export class MotorcycleRoutingError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MotorcycleRoutingError";
  }
}

const ARUA_BOUNDS = {
  minLongitude: 30.55,
  maxLongitude: 31.25,
  minLatitude: 2.75,
  maxLatitude: 3.30
} as const;
const ROUTE_TIMEOUT_MS = 18_000;
const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000;
const ROUTE_CACHE_MAX_ENTRIES = 500;
const VALHALLA_MIN_REQUEST_INTERVAL_MS = 1_100;
const VALHALLA_MAX_ATTEMPTS = 2;

const routeCache = new Map<string, { expiresAt: number; route: MotorcycleRoute }>();
const inFlightRouteRequests = new Map<string, Promise<MotorcycleRoute>>();

let valhallaQueue: Promise<void> = Promise.resolve();
let valhallaNextRequestAt = 0;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * The public FOSSGIS demo service is shared. Serialize requests from this
 * Render instance and keep at least 1.1 seconds between requests, as required
 * by the provider's fair-use limit. A single in-flight queue also prevents
 * several customers triggering simultaneous requests from one server.
 */
function scheduleValhallaRequest<T>(operation: () => Promise<T>): Promise<T> {
  const scheduled = valhallaQueue.then(operation);
  valhallaQueue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

async function waitForValhallaSlot(): Promise<void> {
  const remaining = valhallaNextRequestAt - Date.now();
  if (remaining > 0) await wait(remaining);
  valhallaNextRequestAt = Date.now() + VALHALLA_MIN_REQUEST_INTERVAL_MS;
}

function retryAfterMilliseconds(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function validateAruaCoordinate(point: RouteCoordinate, label: string): void {
  if (
    !Number.isFinite(point.latitude) ||
    !Number.isFinite(point.longitude) ||
    point.latitude < ARUA_BOUNDS.minLatitude ||
    point.latitude > ARUA_BOUNDS.maxLatitude ||
    point.longitude < ARUA_BOUNDS.minLongitude ||
    point.longitude > ARUA_BOUNDS.maxLongitude
  ) {
    throw new MotorcycleRoutingError(
      400,
      "OUTSIDE_SERVICE_AREA",
      `The ${label} location is outside NAVIGO's current Arua service area.`
    );
  }
}

function cacheKey(origin: RouteCoordinate, destination: RouteCoordinate): string {
  const pointKey = (point: RouteCoordinate) =>
    `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;
  return `${pointKey(origin)}>${pointKey(destination)}`;
}

function simplifyCoordinates(coordinates: RouteCoordinate[], maxPoints = 500): RouteCoordinate[] {
  if (coordinates.length <= maxPoints) return coordinates;
  const result: RouteCoordinate[] = [];
  const step = (coordinates.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index += 1) {
    result.push(coordinates[Math.round(index * step)]!);
  }
  return result;
}

/** Decode a Google/Valhalla encoded polyline at the requested decimal precision. */
function decodePolyline(encoded: string, precision: 5 | 6): RouteCoordinate[] {
  const factor = 10 ** precision;
  const points: RouteCoordinate[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  const readDelta = (): number => {
    let result = 0;
    let shift = 0;
    let byte = 0;
    do {
      if (index >= encoded.length) {
        throw new Error("The routing provider returned an incomplete route geometry.");
      }
      byte = encoded.charCodeAt(index++) - 63;
      if (byte < 0 || byte > 63) {
        throw new Error("The routing provider returned invalid route geometry.");
      }
      result |= (byte & 0x1f) << shift;
      shift += 5;
      if (shift > 30) {
        throw new Error("The routing provider returned invalid route geometry.");
      }
    } while (byte >= 0x20);

    return (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
  };

  while (index < encoded.length) {
    latitude += readDelta();
    longitude += readDelta();
    points.push({
      latitude: latitude / factor,
      longitude: longitude / factor
    });
  }
  return points;
}

async function getGoogleTwoWheelerRoute(
  origin: RouteCoordinate,
  destination: RouteCoordinate,
  apiKey: string
): Promise<MotorcycleRoute> {
  let response: Response;
  try {
    response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline"
      },
      body: JSON.stringify({
        origin: {
          location: {
            latLng: { latitude: origin.latitude, longitude: origin.longitude }
          }
        },
        destination: {
          location: {
            latLng: { latitude: destination.latitude, longitude: destination.longitude }
          }
        },
        travelMode: "TWO_WHEELER",
        routingPreference: "TRAFFIC_UNAWARE",
        computeAlternativeRoutes: false,
        languageCode: "en"
      }),
      signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS)
    });
  } catch {
    throw new MotorcycleRoutingError(
      503,
      "ROUTE_PROVIDER_UNAVAILABLE",
      "The motorcycle road-routing service could not be reached. Please try again."
    );
  }

  if (!response.ok) {
    throw new MotorcycleRoutingError(
      503,
      "ROUTE_PROVIDER_UNAVAILABLE",
      "The motorcycle road route is temporarily unavailable. Please try again."
    );
  }

  const payload = await response.json() as {
    routes?: Array<{
      distanceMeters?: number;
      duration?: string;
      polyline?: { encodedPolyline?: string };
    }>;
  };
  const route = payload.routes?.[0];
  const encoded = route?.polyline?.encodedPolyline;
  const durationSeconds = Number(route?.duration?.replace(/s$/, ""));
  if (
    !route ||
    !Number.isFinite(route.distanceMeters) ||
    !Number.isFinite(durationSeconds) ||
    !encoded
  ) {
    throw new MotorcycleRoutingError(
      422,
      "NO_MOTORCYCLE_ROUTE",
      "No suitable motorcycle road route was found between these locations. Try choosing nearby mapped points."
    );
  }

  let coordinates: RouteCoordinate[];
  try {
    coordinates = decodePolyline(encoded, 5);
  } catch {
    throw new MotorcycleRoutingError(
      503,
      "INVALID_ROUTE_GEOMETRY",
      "The road-routing service returned an invalid route. Please try again."
    );
  }

  if (coordinates.length < 2) {
    throw new MotorcycleRoutingError(
      422,
      "NO_MOTORCYCLE_ROUTE",
      "No suitable motorcycle road route was found between these locations."
    );
  }

  return {
    distanceKm: route.distanceMeters! / 1000,
    durationSeconds,
    coordinates: simplifyCoordinates(coordinates),
    provider: "GOOGLE_TWO_WHEELER"
  };
}

async function getValhallaMotorcycleRoute(
  origin: RouteCoordinate,
  destination: RouteCoordinate
): Promise<MotorcycleRoute> {
  const baseUrl = (process.env.VALHALLA_BASE_URL || "https://valhalla1.openstreetmap.de")
    .replace(/\\/+$/, "");
  const clientId = process.env.VALHALLA_CLIENT_ID || "navigo-arua-pilot";
  const requestBody = {
    locations: [
      { lat: origin.latitude, lon: origin.longitude, type: "break" },
      { lat: destination.latitude, lon: destination.longitude, type: "break" }
    ],
    costing: "motorcycle",
    costing_options: {
      motorcycle: {
        use_highways: 0.5,
        use_trails: 0.1
      }
    },
    units: "km",
    language: "en"
  };

  return scheduleValhallaRequest(async () => {
    let lastNetworkError: unknown;

    for (let attempt = 1; attempt <= VALHALLA_MAX_ATTEMPTS; attempt += 1) {
      let response: Response;
      await waitForValhallaSlot();
      try {
        response = await fetch(`${baseUrl}/route`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Client-Id": clientId,
            "User-Agent": "NAVIGO/1.0 (+https://github.com/WilberAsingwire/NavigoUg)"
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(ROUTE_TIMEOUT_MS)
        });
      } catch (error) {
        lastNetworkError = error;
        console.warn("[NAVIGO routing] Valhalla request failed", {
          attempt,
          maxAttempts: VALHALLA_MAX_ATTEMPTS,
          reason: error instanceof Error ? error.name : "unknown"
        });
        if (attempt < VALHALLA_MAX_ATTEMPTS) {
          await wait(VALHALLA_MIN_REQUEST_INTERVAL_MS);
          continue;
        }
        throw new MotorcycleRoutingError(
          503,
          "ROUTE_PROVIDER_UNAVAILABLE",
          "NAVIGO's motorcycle route service did not respond. Please try again in a moment."
        );
      }

      if (response.status === 429 || response.status >= 500 || response.status === 408) {
        const retryAfter = retryAfterMilliseconds(response);
        console.warn("[NAVIGO routing] Valhalla temporarily rejected a route request", {
          status: response.status,
          attempt,
          maxAttempts: VALHALLA_MAX_ATTEMPTS,
          retryAfterMs: retryAfter
        });
        if (attempt < VALHALLA_MAX_ATTEMPTS) {
          await wait(Math.max(VALHALLA_MIN_REQUEST_INTERVAL_MS, retryAfter));
          continue;
        }
        throw new MotorcycleRoutingError(
          503,
          response.status === 429 ? "ROUTE_PROVIDER_RATE_LIMITED" : "ROUTE_PROVIDER_UNAVAILABLE",
          response.status === 429
            ? "The route service is busy. Please wait a moment and tap Show road route & fare again."
            : "The motorcycle route service is temporarily unavailable. Please try again in a moment."
        );
      }

      if (!response.ok) {
        const details = await response.text().catch(() => "");
        console.error("[NAVIGO routing] Valhalla rejected a route request", {
          status: response.status,
          details: details.slice(0, 240)
        });
        throw new MotorcycleRoutingError(
          422,
          "NO_MOTORCYCLE_ROUTE",
          "No suitable motorcycle road route was found between these locations. Try selecting nearby mapped places."
        );
      }

      let payload: {
        trip?: {
          status?: number;
          status_message?: string;
          summary?: { length?: number; time?: number };
          legs?: Array<{ shape?: string }>;
        };
      };
      try {
        payload = await response.json() as typeof payload;
      } catch {
        console.error("[NAVIGO routing] Valhalla returned invalid JSON.");
        throw new MotorcycleRoutingError(
          503,
          "INVALID_ROUTE_RESPONSE",
          "The route service returned an incomplete response. Please try again."
        );
      }

      const trip = payload.trip;
      const distanceKm = Number(trip?.summary?.length);
      const durationSeconds = Number(trip?.summary?.time);
      if (
        !trip ||
        (trip.status !== undefined && trip.status !== 0) ||
        !Number.isFinite(distanceKm) ||
        !Number.isFinite(durationSeconds) ||
        !Array.isArray(trip.legs)
      ) {
        const providerMessage = trip?.status_message?.trim();
        console.warn("[NAVIGO routing] Valhalla could not find a motorcycle route", {
          status: trip?.status,
          statusMessage: providerMessage?.slice(0, 180)
        });
        throw new MotorcycleRoutingError(
          422,
          "NO_MOTORCYCLE_ROUTE",
          providerMessage
            ? `No motorcycle road route was found: ${providerMessage.slice(0, 150)}`
            : "No suitable motorcycle road route was found between these locations. Try choosing nearby mapped places."
        );
      }

      let coordinates: RouteCoordinate[];
      try {
        coordinates = trip.legs.flatMap((leg) =>
          typeof leg.shape === "string" ? decodePolyline(leg.shape, 6) : []
        );
      } catch {
        console.error("[NAVIGO routing] Valhalla returned invalid route geometry.");
        throw new MotorcycleRoutingError(
          503,
          "INVALID_ROUTE_GEOMETRY",
          "The route service returned invalid road geometry. Please try again."
        );
      }

      if (coordinates.length < 2) {
        throw new MotorcycleRoutingError(
          422,
          "NO_MOTORCYCLE_ROUTE",
          "No suitable motorcycle road route was found between these locations. Try choosing nearby mapped places."
        );
      }

      return {
        distanceKm,
        durationSeconds,
        coordinates: simplifyCoordinates(coordinates),
        provider: "VALHALLA_MOTORCYCLE"
      };
    }

    console.error("[NAVIGO routing] Valhalla retries exhausted.", {
      reason: lastNetworkError instanceof Error ? lastNetworkError.name : "unknown"
    });
    throw new MotorcycleRoutingError(
      503,
      "ROUTE_PROVIDER_UNAVAILABLE",
      "NAVIGO's motorcycle route service is temporarily unavailable. Please try again."
    );
  });
}

/**
 * Routes real motorcycle journeys on the road network.
 * Google two-wheeler routing is used when a server-side key is configured;
 * otherwise the OpenStreetMap-based Valhalla motorcycle profile is used.
 * Successful user-requested routes are cached briefly to reduce public demo
 * traffic and keep the quote and booking calculations consistent.
 */
export async function getMotorcycleRoute(
  origin: RouteCoordinate,
  destination: RouteCoordinate
): Promise<MotorcycleRoute> {
  validateAruaCoordinate(origin, "pickup");
  validateAruaCoordinate(destination, "destination");

  const key = cacheKey(origin, destination);
  const cached = routeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.route;
  if (cached) routeCache.delete(key);

  const inFlight = inFlightRouteRequests.get(key);
  if (inFlight) return inFlight;

  const pendingRoute = (async () => {
    const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
    let route: MotorcycleRoute;

    if (googleApiKey) {
      try {
        route = await getGoogleTwoWheelerRoute(origin, destination, googleApiKey);
      } catch (googleError) {
        console.warn("[NAVIGO routing] Google motorcycle routing failed; trying OpenStreetMap Valhalla.", {
          reason: googleError instanceof MotorcycleRoutingError ? googleError.code : "unknown"
        });
        route = await getValhallaMotorcycleRoute(origin, destination);
      }
    } else {
      route = await getValhallaMotorcycleRoute(origin, destination);
    }

    if (!Number.isFinite(route.distanceKm) || route.distanceKm <= 0 || route.coordinates.length < 2) {
      throw new MotorcycleRoutingError(
        422,
        "NO_MOTORCYCLE_ROUTE",
        "No suitable motorcycle road route was found between these locations."
      );
    }

    if (routeCache.size >= ROUTE_CACHE_MAX_ENTRIES) {
      const oldestKey = routeCache.keys().next().value;
      if (oldestKey) routeCache.delete(oldestKey);
    }
    routeCache.set(key, {
      expiresAt: Date.now() + ROUTE_CACHE_TTL_MS,
      route
    });
    return route;
  })();

  inFlightRouteRequests.set(key, pendingRoute);
  try {
    return await pendingRoute;
  } finally {
    inFlightRouteRequests.delete(key);
  }
}
