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
const ROUTE_TIMEOUT_MS = 12_000;
const ROUTE_CACHE_TTL_MS = 5 * 60 * 1000;
const ROUTE_CACHE_MAX_ENTRIES = 500;

const routeCache = new Map<string, { expiresAt: number; route: MotorcycleRoute }>();

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
    .replace(/\/+$/, "");
  const clientId = process.env.VALHALLA_CLIENT_ID || "navigo-arua-pilot";

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/route`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Client-Id": clientId
      },
      body: JSON.stringify({
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
    trip?: {
      status?: number;
      status_message?: string;
      summary?: { length?: number; time?: number };
      legs?: Array<{ shape?: string }>;
    };
  };
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
    throw new MotorcycleRoutingError(
      422,
      "NO_MOTORCYCLE_ROUTE",
      "No suitable motorcycle road route was found between these locations. Try choosing nearby mapped points."
    );
  }

  let coordinates: RouteCoordinate[];
  try {
    coordinates = trip.legs.flatMap((leg) =>
      typeof leg.shape === "string" ? decodePolyline(leg.shape, 6) : []
    );
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
      "No suitable motorcycle road route was found between these locations. Try choosing nearby mapped points."
    );
  }

  return {
    distanceKm,
    durationSeconds,
    coordinates: simplifyCoordinates(coordinates),
    provider: "VALHALLA_MOTORCYCLE"
  };
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

  const googleApiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  let route: MotorcycleRoute;

  if (googleApiKey) {
    try {
      route = await getGoogleTwoWheelerRoute(origin, destination, googleApiKey);
    } catch (googleError) {
      // A configured Google key can expire, hit quota limits, or reject a route.
      // Retry with the OpenStreetMap-based motorcycle profile before failing the quote.
      try {
        route = await getValhallaMotorcycleRoute(origin, destination);
      } catch (fallbackError) {
        const bothProvidersFoundNoRoute =
          googleError instanceof MotorcycleRoutingError &&
          googleError.statusCode === 422 &&
          fallbackError instanceof MotorcycleRoutingError &&
          fallbackError.statusCode === 422;

        if (bothProvidersFoundNoRoute) {
          throw new MotorcycleRoutingError(
            422,
            "NO_MOTORCYCLE_ROUTE",
            "No suitable motorcycle road route was found between these locations. Try choosing nearby mapped points."
          );
        }

        throw new MotorcycleRoutingError(
          503,
          "ROUTE_PROVIDER_UNAVAILABLE",
          "NAVIGO's motorcycle routing services are temporarily unavailable. Please try again."
        );
      }
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
}
