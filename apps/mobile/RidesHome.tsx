import { useCallback, useEffect, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { StatusBar } from "expo-status-bar";
import MapView, { Marker, Polyline } from "react-native-maps";

type Session = {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: {
    id: string;
    fullName: string;
    phone: string;
    role: "CUSTOMER" | "RIDER" | "ADMIN";
    riderApprovalStatus: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED" | null;
  };
};

type PaymentMethod = "CASH" | "MOBILE_MONEY";

type Ride = {
  id: string;
  status: string;
  pickupDescription: string;
  destinationDescription: string;
  fareAmountUgx: number;
  estimatedDistanceKm: number | string | null;
  createdAt: string;
  customer?: { fullName: string } | null;
  rider?: {
    fullName: string;
    phone: string;
    riderProfile?: { motorcyclePlate: string | null; motorcycleDescription: string | null } | null;
  } | null;
  payment?: { method: PaymentMethod; status: "UNPAID" | "PAID" } | null;
};

type RideLocation = {
  latitude: number;
  longitude: number;
  description: string;
};

type RouteCoordinate = {
  latitude: number;
  longitude: number;
};

type Quote = {
  fareAmountUgx: number;
  distanceKm: number;
  fareBasis: "LANDMARK_FARE" | "DISTANCE_RULE";
  durationSeconds: number;
  routeCoordinates: RouteCoordinate[];
  routingProvider: "GOOGLE_TWO_WHEELER" | "VALHALLA_MOTORCYCLE";
};

function routeMapRegion(coordinates: RouteCoordinate[]) {
  const latitudes = coordinates.map((point) => point.latitude);
  const longitudes = coordinates.map((point) => point.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);

  return {
    latitude: (minLatitude + maxLatitude) / 2,
    longitude: (minLongitude + maxLongitude) / 2,
    latitudeDelta: Math.max(0.008, (maxLatitude - minLatitude) * 1.7),
    longitudeDelta: Math.max(0.008, (maxLongitude - minLongitude) * 1.7)
  };
}

type Props = {
  session: Session;
  onSignOut: () => void;
  signingOut: boolean;
};

const API_BASE_URL = "https://navigou-api-2978.onrender.com";
const STATUS_LABELS: Record<string, string> = {
  PENDING: "Looking for a rider",
  ACCEPTED: "Rider assigned",
  ARRIVED_AT_PICKUP: "Rider at pickup",
  IN_PROGRESS: "Trip in progress",
  COMPLETED: "Trip completed",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired"
};

const NEXT_RIDER_STATUS: Record<string, "ARRIVED_AT_PICKUP" | "IN_PROGRESS" | "COMPLETED"> = {
  ACCEPTED: "ARRIVED_AT_PICKUP",
  ARRIVED_AT_PICKUP: "IN_PROGRESS",
  IN_PROGRESS: "COMPLETED"
};

const ARUA_LOCATION_SUGGESTIONS: LocationSuggestion[] = [
  { label: "Muni Site", category: "Local area", searchTerms: ["Muni", "Muni Hill", "Muni Cell"] },
  { label: "Muni University", category: "University", searchTerms: ["Muni", "main campus"] },
  { label: "Muni Girls Secondary School", category: "School", searchTerms: ["Muni Girls", "Muni", "Nyio Ward"] },
  { label: "Arua Central Market", category: "Market" },
  { label: "Old Bus Park, Arua", category: "Transport station" },
  { label: "Arua Regional Referral Hospital", category: "Hospital" },
  { label: "Arua Hill", category: "Hill / neighbourhood" },
  { label: "Arua Hill Stadium", category: "Sports venue" },
  { label: "West Nile Golf Course", category: "Recreation" },
  { label: "Mvara, Arua", category: "Neighbourhood" },
  { label: "Ediofe, Arua", category: "Neighbourhood" },
  { label: "Onduparaka, Arua", category: "Neighbourhood" },
  { label: "Awindiri, Arua", category: "Neighbourhood" },
  { label: "Oli, Arua", category: "Neighbourhood" },
  { label: "Manibe, Arua", category: "Neighbourhood" },
  { label: "Anyafio, Arua", category: "Neighbourhood" },
  { label: "Arua Airport", category: "Airport" },

  // Hostels marked Recommended in Muni University's 2026 inspected-hostel list.
  {
    label: "Las Vegas Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Onzivu", "Muni"],
    searchQuery: "Las Vegas Hostel, Onzivu, Arua, Uganda"
  },
  {
    label: "Elite Upper Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Ocholini", "Muni"],
    searchQuery: "Elite Upper Hostel, Ocholini, Arua, Uganda"
  },
  {
    label: "Elite Lower Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Ocholini", "Muni"],
    searchQuery: "Elite Lower Hostel, Ocholini, Arua, Uganda"
  },
  {
    label: "Green Garden Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Ocholini", "Muni"],
    searchQuery: "Green Garden Hostel, Ocholini, Arua, Uganda"
  },
  {
    label: "Florida Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Ocholini", "Muni"],
    searchQuery: "Florida Hostel, Ocholini, Arua, Uganda"
  },
  {
    label: "Blessing's Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Ocholini", "Muni"],
    searchQuery: "Blessing's Hostel, Ocholini, Arua, Uganda"
  },
  {
    label: "Faith Harvest Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Onzivu", "Muni"],
    searchQuery: "Faith Harvest Hostel, Onzivu, Arua, Uganda"
  },
  {
    label: "St Teresa Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Onzivu", "Muni"],
    searchQuery: "St Teresa Hostel, Onzivu, Arua, Uganda"
  },
  {
    label: "Winner's Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Onzivu", "Muni"],
    searchQuery: "Winner's Hostel, Onzivu, Arua, Uganda"
  },
  {
    label: "Divine Mercy Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Muni"],
    searchQuery: "Divine Mercy Hostel, Arua, Uganda"
  },
  {
    label: "Schorla Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Onzivu", "Tarsila", "Muni"],
    searchQuery: "Schorla Hostel, Onzivu, Arua, Uganda"
  },
  {
    label: "Liana Partell Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Muni Site", "Adrole Gloria", "Muni"],
    searchQuery: "Liana Partell Hostel, Muni Site, Arua, Uganda"
  },
  {
    label: "Jesse Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Muni", "Muni Girls"],
    searchQuery: "Jesse Hostel, Arua, Uganda"
  },
  {
    label: "Ellianze Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "UNITE-Muni", "Muni"],
    searchQuery: "Ellianze Hostel, near UNITE-Muni, Arua, Uganda"
  },
  {
    label: "Scholars' Residence",
    category: "Student residence · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student hostel", "Muni"],
    searchQuery: "Scholars' Residence, Arua, Uganda"
  },
  {
    label: "Jimex Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Muni Site", "Muni"],
    searchQuery: "Jimex Hostel, Muni Site, Arua, Uganda"
  },
  {
    label: "Jehovah Jireh Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Muni"],
    searchQuery: "Jehovah Jireh Hostel, Arua, Uganda"
  },
  {
    label: "Apex Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Muni Site", "Muni"],
    searchQuery: "Apex Hostel, Muni Site, Arua, Uganda"
  },
  {
    label: "Bervlen Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Muni Site", "Muni"],
    searchQuery: "Bervlen Hostel, Muni Site, Arua, Uganda"
  },
  {
    label: "New York Hostel",
    category: "Student hostel · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student residence", "Muni"],
    searchQuery: "New York Hostel, Arua, Uganda"
  },
  {
    label: "Muni Residences",
    category: "Student residence · inspected 2026",
    searchTerms: ["hostel", "accommodation", "student hostel", "Muni Site", "Muni"],
    searchQuery: "Muni Residences, Muni Site, Arua, Uganda"
  },

  // These five appear in the same university document as new hostels awaiting approval.
  {
    label: "Loril Paris Hostel",
    category: "Student hostel · approval pending",
    searchTerms: ["hostel", "accommodation", "Onzivu", "Muni"],
    searchQuery: "Loril Paris Hostel, Onzivu, Arua, Uganda"
  },
  {
    label: "Prime Hostel",
    category: "Student hostel · approval pending",
    searchTerms: ["hostel", "accommodation", "Ocholini", "Muni"],
    searchQuery: "Prime Hostel, Ocholini, Arua, Uganda"
  },
  {
    label: "Elite Executive Hostel",
    category: "Student hostel · approval pending",
    searchTerms: ["hostel", "accommodation", "Ocholini", "Muni"],
    searchQuery: "Elite Executive Hostel, Ocholini, Arua, Uganda"
  },
  {
    label: "Valentina Hostel",
    category: "Student hostel · approval pending",
    searchTerms: ["hostel", "accommodation", "Ocholini", "Muni"],
    searchQuery: "Valentina Hostel, Ocholini, Arua, Uganda"
  },
  {
    label: "Muni University CBC/FMS Hostel",
    category: "Student hostel · approval pending",
    searchTerms: ["hostel", "accommodation", "CBC", "FMS", "Muni University", "Muni"],
    searchQuery: "Muni University CBC FMS Hostel, Arua, Uganda"
  }
];

type LocationSuggestion = {
  label: string;
  category: string;
  latitude?: number;
  longitude?: number;
  searchTerms?: string[];
  searchQuery?: string;
};

type PhotonFeature = {
  geometry?: { coordinates?: number[] };
  properties?: {
    name?: string;
    street?: string;
    district?: string;
    city?: string;
    county?: string;
    state?: string;
    country?: string;
    osm_key?: string;
    osm_value?: string;
    extra?: Record<string, string | number | boolean | null>;
  };
};

async function apiRequest<T>(
  path: string,
  token: string,
  init: Parameters<typeof fetch>[1] = {},
  refreshAccessToken?: () => Promise<string>
): Promise<T> {
  const send = (accessToken: string) => fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {})
    }
  });

  let response = await send(token);
  if (response.status === 401 && refreshAccessToken) {
    const renewedToken = await refreshAccessToken();
    response = await send(renewedToken);
  }

  const payload = await response.json().catch(() => null) as T | { error?: { message?: string } } | null;
  if (!response.ok) {
    const message = (payload as { error?: { message?: string } } | null)?.error?.message;
    throw new Error(message || "Unable to complete this action. Please try again.");
  }
  return payload as T;
}

function money(value: number): string {
  return `UGX ${Math.round(value).toLocaleString("en-UG")}`;
}

function formatDistance(value: number | string | null): string {
  if (value === null) return "Distance estimate unavailable";
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(2)} km estimated` : "Distance estimate unavailable";
}

function describeMapFeature(
  key?: string,
  value?: string,
  extra?: Record<string, string | number | boolean | null>
): string {
  const tag = (value ?? "").toLowerCase();
  const normalizedKey = (key ?? "").toLowerCase();
  const bridge = String(extra?.bridge ?? "").toLowerCase();
  const ford = String(extra?.ford ?? "").toLowerCase();
  const tunnel = String(extra?.tunnel ?? "").toLowerCase();

  if (bridge && bridge !== "no") return "Bridge / road crossing";
  if (ford && ford !== "no") return "Ford / water crossing";
  if (tunnel && tunnel !== "no") return "Tunnel";

  if (normalizedKey === "waterway") {
    const labels: Record<string, string> = {
      river: "River",
      stream: "Stream",
      canal: "Canal",
      drain: "Drainage channel",
      ditch: "Ditch",
      waterfall: "Waterfall",
      dam: "Dam",
      weir: "Weir",
      riverbank: "River bank",
      lock: "Canal lock"
    };
    return labels[tag] ?? "Waterway";
  }

  if (normalizedKey === "natural") {
    const labels: Record<string, string> = {
      peak: "Hill / peak",
      hill: "Hill",
      ridge: "Ridge",
      saddle: "Mountain pass",
      isthmus: "Land passage",
      volcano: "Volcano",
      valley: "Valley",
      cliff: "Cliff",
      spring: "Spring",
      water: "Water body",
      wetland: "Wetland",
      bay: "Bay",
      beach: "Beach",
      wood: "Woodland",
      scrub: "Scrubland",
      heath: "Heath",
      grassland: "Grassland"
    };
    return labels[tag] ?? "Natural feature";
  }

  if (normalizedKey === "place") {
    const labels: Record<string, string> = {
      city: "City",
      town: "Town",
      village: "Village",
      suburb: "Suburb",
      neighbourhood: "Neighbourhood",
      quarter: "Neighbourhood",
      hamlet: "Hamlet",
      locality: "Locality",
      district: "District"
    };
    return labels[tag] ?? "Area";
  }

  if (normalizedKey === "highway") {
    if (tag === "bus_stop") return "Bus stop";
    if (tag === "path" || tag === "footway" || tag === "pedestrian") return "Path / footway";
    if (tag === "track") return "Track";
    if (tag === "steps") return "Steps";
    if (tag === "crossing") return "Road crossing";
    return "Road";
  }

  if (normalizedKey === "bridge" || (normalizedKey === "man_made" && tag === "bridge")) return "Bridge";
  if (normalizedKey === "ford") return "River crossing / ford";
  if (normalizedKey === "water") {
    const labels: Record<string, string> = {
      lake: "Lake",
      pond: "Pond",
      reservoir: "Reservoir",
      river: "River",
      basin: "Water basin"
    };
    return labels[tag] ?? "Water feature";
  }
  if (normalizedKey === "barrier") return "Access barrier / crossing control";
  if (normalizedKey === "railway") return "Railway feature";
  if (normalizedKey === "aeroway") return "Airport / airfield feature";
  if (normalizedKey === "amenity") return tag ? tag.replace(/_/g, " ") : "Public facility";
  if (normalizedKey === "shop") return tag ? `${tag.replace(/_/g, " ")} shop` : "Shop";
  if (normalizedKey === "office") return tag ? `${tag.replace(/_/g, " ")} office` : "Office";
  if (normalizedKey === "tourism") {
    const labels: Record<string, string> = {
      hostel: "Student hostel",
      guest_house: "Guest house",
      hotel: "Hotel",
      motel: "Motel",
      apartment: "Serviced accommodation",
      chalet: "Chalet",
      camp_site: "Camp site",
      caravan_site: "Caravan site"
    };
    return labels[tag] ?? (tag ? tag.replace(/_/g, " ") : "Place to visit");
  }
  if (normalizedKey === "amenity" && (tag === "dormitory" || tag === "student_accommodation")) {
    return "Student accommodation";
  }
  if (normalizedKey === "leisure") return tag ? tag.replace(/_/g, " ") : "Recreation";
  if (normalizedKey === "building") return "Building";
  if (normalizedKey === "landuse") return "Land use";
  if (normalizedKey === "boundary") return "Boundary / administrative area";

  return tag ? tag.replace(/_/g, " ") : "Mapped place";
}

async function geocodeAruaAddress(value: string): Promise<RideLocation> {
  const trimmed = value.trim();
  if (trimmed.length < 3) throw new Error("Enter a pickup or destination address.");

  // Use the same Arua-bounded Photon map search as autocomplete.
  // Address geocoding must not depend on Android device-location permission.
  const query = /uganda/i.test(trimmed) ? trimmed : `${trimmed}, Arua, Uganda`;
  const params = [
    `q=${encodeURIComponent(query)}`,
    "lat=3.02",
    "lon=30.92",
    "zoom=11",
    "location_bias_scale=0.2",
    "limit=5",
    "lang=en",
    "countrycode=UG",
    "bbox=30.55,2.75,31.25,3.30"
  ].join("&");

  let response: Response;
  try {
    response = await fetch(`https://photon.komoot.io/api/?${params}`, {
      headers: { Accept: "application/json" }
    });
  } catch {
    throw new Error("Unable to search the Arua map right now. Check your internet connection and try again.");
  }

  if (!response.ok) {
    throw new Error("The Arua location service is temporarily unavailable. Please try again.");
  }

  const payload = await response.json() as { features?: PhotonFeature[] };
  const candidates = (payload.features ?? []).flatMap((feature) => {
    const coordinates = feature.geometry?.coordinates;
    if (!coordinates || coordinates.length < 2) return [];
    const longitude = Number(coordinates[0]);
    const latitude = Number(coordinates[1]);

    // Enforce the service area even if a provider returns an out-of-area match.
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      longitude < 30.55 ||
      longitude > 31.25 ||
      latitude < 2.75 ||
      latitude > 3.30
    ) return [];

    return [{ latitude, longitude }];
  });

  const firstResult = candidates[0];
  if (!firstResult) {
    throw new Error(`We couldn't find "${trimmed}" on the Arua map. Choose one of the suggested places or add a nearby landmark and try again.`);
  }

  return {
    latitude: firstResult.latitude,
    longitude: firstResult.longitude,
    description: trimmed
  };
}

export default function RidesHome({ session, onSignOut, signingOut }: Props) {
  const isCustomer = session.user.role === "CUSTOMER";
  const isApprovedRider = session.user.role === "RIDER" && session.user.riderApprovalStatus === "APPROVED";
  const [activeSession, setActiveSession] = useState(session);
  const refreshTokenRef = useRef(session.refreshToken);
  refreshTokenRef.current = activeSession.refreshToken;
  const refreshInFlight = useRef<Promise<string> | null>(null);

  const refreshAccessToken = useCallback(async (): Promise<string> => {
    if (refreshInFlight.current) return refreshInFlight.current;

    const pending = (async () => {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: refreshTokenRef.current })
      });
      const payload = await response.json().catch(() => null) as
        | { data?: Session; error?: { message?: string } }
        | null;

      if (!response.ok || !payload?.data?.accessToken || !payload.data.refreshToken) {
        if (response.status === 401) {
          await onSignOut();
        }
        throw new Error(payload?.error?.message || "Your session has expired. Please sign in again.");
      }

      const renewedSession = payload.data;
      await SecureStore.setItemAsync("navigo.session", JSON.stringify(renewedSession));
      setActiveSession(renewedSession);
      return renewedSession.accessToken;
    })();

    refreshInFlight.current = pending;
    try {
      return await pending;
    } finally {
      if (refreshInFlight.current === pending) refreshInFlight.current = null;
    }
  }, [onSignOut]);

  const [tab, setTab] = useState<"book" | "history">("book");
  const [pickup, setPickup] = useState("");
  const [destination, setDestination] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [locations, setLocations] = useState<{ pickup: RideLocation; destination: RideLocation } | null>(null);
  const [selectedPickupLocation, setSelectedPickupLocation] = useState<RideLocation | null>(null);
  const [selectedDestinationLocation, setSelectedDestinationLocation] = useState<RideLocation | null>(null);
  const [selectedPickupSearchQuery, setSelectedPickupSearchQuery] = useState("");
  const [selectedDestinationSearchQuery, setSelectedDestinationSearchQuery] = useState("");
  const [rides, setRides] = useState<Ride[]>([]);
  const [availableRides, setAvailableRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [activeLocationField, setActiveLocationField] = useState<"pickup" | "destination" | null>(null);

  const loadDashboard = useCallback(async () => {
    if (session.user.role === "ADMIN") {
      setRides([]);
      setAvailableRides([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const mine = await apiRequest<{ data: Ride[] }>("/api/v1/rides/mine", activeSession.accessToken, undefined, refreshAccessToken);
      setRides(mine.data ?? []);
      if (isApprovedRider) {
        const available = await apiRequest<{ data: Ride[] }>("/api/v1/rides/available", activeSession.accessToken, undefined, refreshAccessToken);
        setAvailableRides(available.data ?? []);
      } else {
        setAvailableRides([]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load your rides.");
    } finally {
      setLoading(false);
    }
  }, [activeSession.accessToken, session.user.role, isApprovedRider, refreshAccessToken]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  async function getFareEstimate() {
    setWorking(true);
    setError("");
    setMessage("");
    setQuote(null);
    setLocations(null);
    try {
      const [pickupLocation, destinationLocation] = await Promise.all([
        selectedPickupLocation ?? geocodeAruaAddress(selectedPickupSearchQuery || pickup),
        selectedDestinationLocation ?? geocodeAruaAddress(selectedDestinationSearchQuery || destination)
      ]);
      const result = await apiRequest<{ data: Quote }>("/api/v1/rides/fare-quote", activeSession.accessToken, {
        method: "POST",
        body: JSON.stringify({ pickup: pickupLocation, destination: destinationLocation })
      }, refreshAccessToken);
      setLocations({ pickup: pickupLocation, destination: destinationLocation });
      setQuote(result.data);
    } catch (quoteError) {
      setError(quoteError instanceof Error ? quoteError.message : "Unable to calculate the fare.");
    } finally {
      setWorking(false);
    }
  }

  async function requestRide() {
    if (!quote || !locations) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await apiRequest<{ data: Ride }>("/api/v1/rides", activeSession.accessToken, {
        method: "POST",
        body: JSON.stringify({ ...locations, paymentMethod })
      }, refreshAccessToken);
      setMessage("Your ride request has been sent. We'll show it here as soon as a rider accepts.");
      setQuote(null);
      setLocations(null);
      setPickup("");
      setDestination("");
      setTab("history");
      await loadDashboard();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create the ride request.");
    } finally {
      setWorking(false);
    }
  }

  async function performRideAction(rideId: string, action: "accept" | "cancel" | "ARRIVED_AT_PICKUP" | "IN_PROGRESS" | "COMPLETED") {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      if (action === "accept") {
        await apiRequest(`/api/v1/rides/${rideId}/accept`, activeSession.accessToken, { method: "POST" }, refreshAccessToken);
      } else if (action === "cancel") {
        await apiRequest(`/api/v1/rides/${rideId}/cancel`, activeSession.accessToken, { method: "POST" }, refreshAccessToken);
      } else {
        await apiRequest(`/api/v1/rides/${rideId}/status`, activeSession.accessToken, {
          method: "PATCH",
          body: JSON.stringify({ status: action })
        }, refreshAccessToken);
      }
      setMessage(action === "accept" ? "Ride accepted. The customer can now see your assignment." : "Ride status updated.");
      await loadDashboard();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update this ride.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.brandSmall}>NAVIGO</Text>
            <Text style={styles.greeting}>Hello, {session.user.fullName.split(" ")[0]}</Text>
            <Text style={styles.muted}>{isCustomer ? "Your ride starts here" : "Your rider workspace"}</Text>
          </View>
          <TouchableOpacity style={styles.signOut} onPress={onSignOut} disabled={signingOut}>
            {signingOut ? <ActivityIndicator color="#174A72" /> : <Text style={styles.signOutText}>Sign out</Text>}
          </TouchableOpacity>
        </View>

        {isCustomer ? (
          <>
            <View style={styles.heroCard}>
              <Text style={styles.heroEyebrow}>MOTORCYCLE RIDES</Text>
              <Text style={styles.heroTitle}>Where would you like to go?</Text>
              <Text style={styles.heroText}>Set your pickup and destination in Arua to see an estimated fare.</Text>
            </View>

            <View style={styles.tabRow}>
              <TabButton label="Book a ride" selected={tab === "book"} onPress={() => setTab("book")} />
              <TabButton label="My rides" selected={tab === "history"} onPress={() => { setTab("history"); void loadDashboard(); }} />
            </View>

            {tab === "book" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Plan your trip</Text>
                <Text style={styles.label}>Pickup location</Text>
                <TextInput
                  style={styles.addressInput}
                  value={pickup}
                  onFocus={() => setActiveLocationField("pickup")}
                  onChangeText={(value) => {
                    setPickup(value);
                    setSelectedPickupLocation(null);
                    setSelectedPickupSearchQuery("");
                    setQuote(null);
                    setLocations(null);
                  }}
                  placeholder="e.g. Muni University or Arua Main Market"
                  placeholderTextColor="#98A2B3"
                />
                <LocationSuggestions
                  visible={activeLocationField === "pickup"}
                  query={pickup}
                  onSelect={(suggestion) => {
                    setPickup(suggestion.label);
                    setSelectedPickupLocation(
                      suggestion.latitude !== undefined && suggestion.longitude !== undefined
                        ? { latitude: suggestion.latitude, longitude: suggestion.longitude, description: suggestion.label }
                        : null
                    );
                    setSelectedPickupSearchQuery(suggestion.searchQuery ?? "");
                    setActiveLocationField(null);
                    setQuote(null);
                    setLocations(null);
                  }}
                />
                <Text style={styles.label}>Destination</Text>
                <TextInput
                  style={styles.addressInput}
                  value={destination}
                  onFocus={() => setActiveLocationField("destination")}
                  onChangeText={(value) => {
                    setDestination(value);
                    setSelectedDestinationLocation(null);
                    setSelectedDestinationSearchQuery("");
                    setQuote(null);
                    setLocations(null);
                  }}
                  placeholder="e.g. Muni Site or Arua Hill"
                  placeholderTextColor="#98A2B3"
                />
                <LocationSuggestions
                  visible={activeLocationField === "destination"}
                  query={destination}
                  onSelect={(suggestion) => {
                    setDestination(suggestion.label);
                    setSelectedDestinationLocation(
                      suggestion.latitude !== undefined && suggestion.longitude !== undefined
                        ? { latitude: suggestion.latitude, longitude: suggestion.longitude, description: suggestion.label }
                        : null
                    );
                    setSelectedDestinationSearchQuery(suggestion.searchQuery ?? "");
                    setActiveLocationField(null);
                    setQuote(null);
                    setLocations(null);
                  }}
                />

                <Text style={styles.label}>Payment preference</Text>
                <View style={styles.paymentRow}>
                  <ChoiceButton label="Cash" selected={paymentMethod === "CASH"} onPress={() => setPaymentMethod("CASH")} />
                  <ChoiceButton label="Mobile Money" selected={paymentMethod === "MOBILE_MONEY"} onPress={() => setPaymentMethod("MOBILE_MONEY")} />
                </View>

                {quote && locations && (
                  <>
                    <View style={styles.routeMapFrame}>
                      <MapView
                        style={styles.routeMap}
                        initialRegion={routeMapRegion(quote.routeCoordinates)}
                        scrollEnabled={false}
                        zoomEnabled={false}
                        rotateEnabled={false}
                        pitchEnabled={false}
                        toolbarEnabled={false}
                        showsCompass={false}
                        showsScale={false}
                        loadingEnabled
                      >
                        <Polyline
                          coordinates={quote.routeCoordinates}
                          strokeColor="#1F76A8"
                          strokeWidth={5}
                        />
                        <Marker coordinate={locations.pickup} title="Pickup" pinColor="#21865B" />
                        <Marker coordinate={locations.destination} title="Destination" pinColor="#C54848" />
                      </MapView>
                    </View>
                    {quote.routingProvider === "VALHALLA_MOTORCYCLE" ? (
                      <Text style={styles.attributionText}>Road route data © OpenStreetMap contributors</Text>
                    ) : null}
                    <View style={styles.quoteCard}>
                      <Text style={styles.quoteLabel}>ESTIMATED FARE</Text>
                      <Text style={styles.quoteAmount}>{money(quote.fareAmountUgx)}</Text>
                      <Text style={styles.quoteNote}>{quote.distanceKm.toFixed(2)} km by motorcycle road route</Text>
                      <Text style={styles.quoteNote}>About {Math.max(1, Math.ceil(quote.durationSeconds / 60))} minutes estimated travel time</Text>
                      <Text style={styles.quoteNote}>Route and time are estimates. Road conditions and diversions may change the actual journey.</Text>
                    </View>
                  </>
                )}

                {error ? <Notice tone="error" text={error} /> : null}
                {message ? <Notice tone="success" text={message} /> : null}

                {!quote ? (
                  <PrimaryButton label="Calculate fare" loading={working} onPress={getFareEstimate} disabled={working || !pickup.trim() || !destination.trim()} />
                ) : (
                  <PrimaryButton label="Confirm ride request" loading={working} onPress={requestRide} disabled={working} />
                )}
              </View>
            ) : (
              <View style={styles.section}>
                <SectionHeader title="Your ride requests" onRefresh={loadDashboard} loading={loading} />
                {rides.length ? rides.map((ride) => (
                  <RideCard
                    key={ride.id}
                    ride={ride}
                    customerView
                    busy={working}
                    onCancel={() => performRideAction(ride.id, "cancel")}
                  />
                )) : <EmptyState title="No rides yet" text="Your ride requests and trip history will appear here." />}
                {error ? <Notice tone="error" text={error} /> : null}
                {message ? <Notice tone="success" text={message} /> : null}
              </View>
            )}
          </>
        ) : session.user.role === "RIDER" ? (
          <>
            {session.user.riderApprovalStatus !== "APPROVED" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Rider application status</Text>
                <View style={styles.statusPill}>
                  <Text style={styles.statusPillText}>{session.user.riderApprovalStatus ?? "NOT SET"}</Text>
                </View>
                <Text style={styles.bodyText}>
                  {session.user.riderApprovalStatus === "PENDING"
                    ? "Thank you for applying. Your details are waiting for administrator review. You can access ride requests after your account is approved."
                    : "Your rider account is not approved for accepting bookings. Please contact NAVIGO support for guidance."}
                </Text>
              </View>
            ) : (
              <>
                <View style={styles.heroCard}>
                  <Text style={styles.heroEyebrow}>RIDER REQUESTS</Text>
                  <Text style={styles.heroTitle}>Find your next ride.</Text>
                  <Text style={styles.heroText}>Review pending customer requests and accept a ride when you are ready.</Text>
                </View>
                <SectionHeader title="Available rides" onRefresh={loadDashboard} loading={loading} />
                {availableRides.length ? availableRides.map((ride) => (
                  <RideCard
                    key={ride.id}
                    ride={ride}
                    busy={working}
                    riderView
                    onAccept={() => performRideAction(ride.id, "accept")}
                  />
                )) : <EmptyState title="No available rides" text="New customer requests will appear here. Pull to refresh or tap refresh." />}

                <SectionHeader title="My assigned rides" onRefresh={loadDashboard} loading={loading} />
                {rides.length ? rides.map((ride) => {
                  const nextStatus = NEXT_RIDER_STATUS[ride.status];
                  return (
                    <RideCard
                      key={ride.id}
                      ride={ride}
                      busy={working}
                      riderView
                      onAdvance={nextStatus ? () => performRideAction(ride.id, nextStatus) : undefined}
                    />
                  );
                }) : <EmptyState title="No assigned rides" text="Rides you accept will appear here." />}
              </>
            )}
            {error ? <Notice tone="error" text={error} /> : null}
            {message ? <Notice tone="success" text={message} /> : null}
          </>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Administrator account</Text>
            <Text style={styles.bodyText}>Administrator controls will be available in the NAVIGO management workspace.</Text>
          </View>
        )}

        {loading && (
          <View style={styles.loadingRow}>
            <ActivityIndicator color="#174A72" />
            <Text style={styles.muted}>Loading your NAVIGO workspace...</Text>
          </View>
        )}
        <Text style={styles.footer}>NAVIGO • Arua, Uganda</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function LocationSuggestions({
  visible,
  query,
  onSelect
}: {
  visible: boolean;
  query: string;
  onSelect: (suggestion: LocationSuggestion) => void;
}) {
  const [remoteMatches, setRemoteMatches] = useState<LocationSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);

  useEffect(() => {
    const term = query.trim();
    if (!visible || !term) {
      setRemoteMatches([]);
      setSearching(false);
      setSearchFailed(false);
      return undefined;
    }

    let cancelled = false;
    const controller = new AbortController();
    setSearching(true);
    setSearchFailed(false);

    const timer = setTimeout(async () => {
      try {
        const params = [
          `q=${encodeURIComponent(term)}`,
          "lat=3.02",
          "lon=30.92",
          "zoom=11",
          "location_bias_scale=0.2",
          "limit=12",
          "lang=en",
          "countrycode=UG",
          "bbox=30.55,2.75,31.25,3.30"
        ].join("&");
        const response = await fetch(`https://photon.komoot.io/api/?${params}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal
        });
        if (!response.ok) throw new Error("Location search is temporarily unavailable.");

        const payload = await response.json() as { features?: PhotonFeature[] };
        const mapped = (payload.features ?? []).flatMap((feature): LocationSuggestion[] => {
          const properties = feature.properties;
          const coordinates = feature.geometry?.coordinates;
          if (!properties || !coordinates || coordinates.length < 2) return [];
          const longitude = Number(coordinates[0]);
          const latitude = Number(coordinates[1]);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];

          const primary = properties.name || properties.street || properties.district || properties.city;
          if (!primary) return [];
          const details = [
            properties.district,
            properties.city,
            properties.county,
            properties.state,
            properties.country
          ].filter((part): part is string => Boolean(part) && part !== primary);
          const uniqueDetails = [...new Set(details)];
          const category = describeMapFeature(
            properties.osm_key,
            properties.osm_value,
            properties.extra
          );
          return [{
            label: [primary, ...uniqueDetails].join(", "),
            category,
            latitude,
            longitude
          }];
        });

        if (!cancelled) setRemoteMatches(mapped);
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === "AbortError")) {
          setSearchFailed(true);
          setRemoteMatches([]);
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, visible]);

  if (!visible || !query.trim()) return null;

  const normalized = query.trim().toLowerCase();
  const localMatches = ARUA_LOCATION_SUGGESTIONS
    .filter((location) => [
      location.label,
      location.category,
      ...(location.searchTerms ?? [])
    ].some((field) => field.toLowerCase().includes(normalized)))
    .sort((a, b) => {
      const aStarts = a.label.toLowerCase().startsWith(normalized) ? 0 : 1;
      const bStarts = b.label.toLowerCase().startsWith(normalized) ? 0 : 1;
      return aStarts - bStarts || a.label.localeCompare(b.label);
    });
  const combined = [...localMatches, ...remoteMatches];
  const uniqueMatches = combined.filter((item, index, all) =>
    all.findIndex((candidate) => candidate.label.toLowerCase() === item.label.toLowerCase()) === index
  );

  return (
    <View style={styles.suggestionList}>
      <View style={styles.suggestionTitleRow}>
        <Text style={styles.suggestionHeading}>PLACES NEAR ARUA</Text>
        {searching ? <Text style={styles.suggestionLoading}>Searching...</Text> : null}
      </View>
      {uniqueMatches.length ? uniqueMatches.map((suggestion) => (
        <TouchableOpacity
          key={suggestion.label}
          style={styles.suggestionItem}
          onPress={() => onSelect(suggestion)}
        >
          <View style={styles.suggestionCopy}>
            <Text style={styles.suggestionText}>{suggestion.label}</Text>
            <Text style={styles.suggestionCategory}>{suggestion.category}</Text>
          </View>
        </TouchableOpacity>
      )) : searching ? null : (
        <Text style={styles.noSuggestionText}>
          {searchFailed
            ? "Online place search is unavailable. You can still enter a full location."
            : "No places matched yet. Try more letters or enter the full location."}
        </Text>
      )}
      <Text style={styles.attributionText}>Place data © OpenStreetMap contributors</Text>
    </View>
  );
}

function TabButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.tabButton, selected && styles.tabButtonSelected]}>
      <Text style={[styles.tabText, selected && styles.tabTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ChoiceButton({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.choiceButton, selected && styles.choiceButtonSelected]}>
      <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{label}</Text>
    </TouchableOpacity>
  );
}

function PrimaryButton({ label, loading, onPress, disabled }: { label: string; loading: boolean; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled || loading} style={[styles.primaryButton, (disabled || loading) && styles.disabledButton]}>
      {loading ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>{label}</Text>}
    </TouchableOpacity>
  );
}

function SectionHeader({ title, onRefresh, loading }: { title: string; onRefresh: () => void; loading: boolean }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <TouchableOpacity onPress={onRefresh} disabled={loading}>
        <Text style={styles.refreshText}>{loading ? "Loading..." : "Refresh"}</Text>
      </TouchableOpacity>
    </View>
  );
}

function RideCard({
  ride,
  customerView = false,
  riderView = false,
  busy = false,
  onCancel,
  onAccept,
  onAdvance
}: {
  ride: Ride;
  customerView?: boolean;
  riderView?: boolean;
  busy?: boolean;
  onCancel?: () => void;
  onAccept?: () => void;
  onAdvance?: () => void;
}) {
  const canCancel = customerView && (ride.status === "PENDING" || ride.status === "ACCEPTED");
  const nextLabel: Record<string, string> = {
    ACCEPTED: "Confirm arrival at pickup",
    ARRIVED_AT_PICKUP: "Start trip",
    IN_PROGRESS: "Complete trip"
  };
  return (
    <View style={styles.rideCard}>
      <View style={styles.rideTopRow}>
        <Text style={styles.rideStatus}>{STATUS_LABELS[ride.status] ?? ride.status}</Text>
        <Text style={styles.rideFare}>{money(ride.fareAmountUgx)}</Text>
      </View>
      <View style={styles.routeRow}>
        <View style={styles.routeMarkers}>
          <View style={styles.pickupDot} />
          <View style={styles.routeLine} />
          <View style={styles.destinationDot} />
        </View>
        <View style={styles.routeTexts}>
          <Text style={styles.routeLabel}>PICKUP</Text>
          <Text style={styles.routeAddress}>{ride.pickupDescription}</Text>
          <Text style={[styles.routeLabel, styles.destinationLabel]}>DESTINATION</Text>
          <Text style={styles.routeAddress}>{ride.destinationDescription}</Text>
        </View>
      </View>
      <Text style={styles.rideMeta}>
        {formatDistance(ride.estimatedDistanceKm)} • {ride.payment?.method === "MOBILE_MONEY" ? "Mobile Money" : "Cash"}
      </Text>
      {customerView && ride.rider ? (
        <View style={styles.assignedRider}>
          <Text style={styles.assignedLabel}>YOUR RIDER</Text>
          <Text style={styles.assignedName}>{ride.rider.fullName}</Text>
          <Text style={styles.rideMeta}>{ride.rider.phone}{ride.rider.riderProfile?.motorcyclePlate ? ` • ${ride.rider.riderProfile.motorcyclePlate}` : ""}</Text>
        </View>
      ) : null}
      {riderView && ride.customer ? <Text style={styles.rideMeta}>Customer: {ride.customer.fullName}</Text> : null}
      {onAccept ? <PrimaryButton label="Accept this ride" loading={busy} onPress={onAccept} disabled={busy} /> : null}
      {onAdvance ? <PrimaryButton label={nextLabel[ride.status] ?? "Update ride"} loading={busy} onPress={onAdvance} disabled={busy} /> : null}
      {canCancel && onCancel ? (
        <TouchableOpacity onPress={onCancel} disabled={busy} style={styles.cancelButton}>
          <Text style={styles.cancelText}>Cancel ride</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

function Notice({ tone, text }: { tone: "error" | "success"; text: string }) {
  return (
    <View style={[styles.notice, tone === "error" ? styles.errorNotice : styles.successNotice]}>
      <Text style={[styles.noticeText, tone === "error" ? styles.errorNoticeText : styles.successNoticeText]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F3F6FA" },
  page: { flexGrow: 1, paddingHorizontal: 19, paddingTop: 20, paddingBottom: 30 },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  brandSmall: { color: "#174A72", fontSize: 12, fontWeight: "900", letterSpacing: 2 },
  greeting: { color: "#142B3D", fontSize: 24, fontWeight: "800", marginTop: 4 },
  muted: { color: "#8793A2", fontSize: 12, marginTop: 4 },
  signOut: { borderWidth: 1, borderColor: "#D5DFE8", paddingHorizontal: 13, paddingVertical: 9, borderRadius: 10, backgroundColor: "#FFFFFF" },
  signOutText: { color: "#174A72", fontWeight: "700", fontSize: 12 },
  heroCard: { backgroundColor: "#174A72", borderRadius: 20, padding: 20, marginBottom: 18 },
  heroEyebrow: { color: "#BDD7EA", fontSize: 10, fontWeight: "800", letterSpacing: 1.4 },
  heroTitle: { color: "#FFFFFF", fontSize: 23, fontWeight: "800", marginTop: 8 },
  heroText: { color: "#DCEAF4", fontSize: 12, lineHeight: 19, marginTop: 7 },
  tabRow: { flexDirection: "row", backgroundColor: "#E8EEF4", borderRadius: 13, padding: 4, marginBottom: 15 },
  tabButton: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 10 },
  tabButtonSelected: { backgroundColor: "#FFFFFF" },
  tabText: { color: "#667085", fontSize: 12, fontWeight: "700" },
  tabTextSelected: { color: "#174A72" },
  card: { backgroundColor: "#FFFFFF", borderRadius: 18, padding: 17, borderWidth: 1, borderColor: "#E5EAF0", marginBottom: 17 },
  cardTitle: { color: "#182230", fontSize: 17, fontWeight: "800", marginBottom: 16 },
  label: { color: "#344054", fontSize: 12, fontWeight: "700", marginBottom: 7, marginTop: 10 },
  addressInput: { minHeight: 48, borderWidth: 1, borderColor: "#DCE3EB", borderRadius: 11, paddingHorizontal: 13, color: "#182230", backgroundColor: "#FBFCFE", fontSize: 13 },
  suggestionList: { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E5EAF0", borderRadius: 11, marginTop: 5, marginBottom: 5, paddingHorizontal: 11, paddingVertical: 8 },
  suggestionTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  suggestionHeading: { color: "#98A2B3", fontSize: 9, fontWeight: "800", letterSpacing: 1, paddingVertical: 5 },
  suggestionLoading: { color: "#236B9A", fontSize: 9, fontWeight: "700" },
  suggestionItem: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#F0F2F5" },
  suggestionCopy: { flex: 1, gap: 3 },
  suggestionText: { color: "#344054", fontSize: 12, fontWeight: "600" },
  suggestionCategory: { color: "#8793A2", fontSize: 9, textTransform: "capitalize" },
  noSuggestionText: { color: "#8793A2", fontSize: 11, lineHeight: 16, paddingVertical: 8 },
  attributionText: { color: "#A0A8B2", fontSize: 8, marginTop: 5, textAlign: "right" },
  paymentRow: { flexDirection: "row", gap: 9, marginTop: 2, marginBottom: 13 },
  choiceButton: { flex: 1, alignItems: "center", borderWidth: 1, borderColor: "#DCE3EB", borderRadius: 10, paddingVertical: 11, backgroundColor: "#FFFFFF" },
  choiceButtonSelected: { borderColor: "#2B719F", backgroundColor: "#F0F7FC" },
  choiceText: { color: "#667085", fontSize: 12, fontWeight: "700" },
  choiceTextSelected: { color: "#174A72" },
  routeMapFrame: { height: 190, borderRadius: 13, overflow: "hidden", marginTop: 10, borderWidth: 1, borderColor: "#DCE3EB" },
  routeMap: { width: "100%", height: "100%" },
  quoteCard: { backgroundColor: "#F0F7FC", borderWidth: 1, borderColor: "#D3E6F3", borderRadius: 13, padding: 14, marginTop: 6, marginBottom: 13 },
  quoteLabel: { color: "#497A9B", fontSize: 9, fontWeight: "800", letterSpacing: 1.1 },
  quoteAmount: { color: "#174A72", fontSize: 25, fontWeight: "900", marginTop: 4 },
  quoteNote: { color: "#667085", fontSize: 10, marginTop: 4 },
  primaryButton: { minHeight: 49, backgroundColor: "#174A72", borderRadius: 12, alignItems: "center", justifyContent: "center", marginTop: 12, paddingHorizontal: 12 },
  primaryButtonText: { color: "#FFFFFF", fontWeight: "800", fontSize: 13 },
  disabledButton: { opacity: 0.6 },
  section: { marginTop: 4 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10, marginBottom: 10 },
  sectionTitle: { color: "#182230", fontWeight: "800", fontSize: 16 },
  refreshText: { color: "#236B9A", fontWeight: "700", fontSize: 12 },
  rideCard: { backgroundColor: "#FFFFFF", borderRadius: 16, padding: 15, borderWidth: 1, borderColor: "#E5EAF0", marginBottom: 12 },
  rideTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 13 },
  rideStatus: { color: "#174A72", fontWeight: "800", fontSize: 12, flex: 1 },
  rideFare: { color: "#142B3D", fontWeight: "900", fontSize: 14 },
  routeRow: { flexDirection: "row", alignItems: "stretch" },
  routeMarkers: { width: 22, alignItems: "center", paddingTop: 3 },
  pickupDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 2, borderColor: "#25825B", backgroundColor: "#FFFFFF" },
  routeLine: { width: 1, flex: 1, minHeight: 20, backgroundColor: "#C5D0DA", marginVertical: 3 },
  destinationDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#174A72" },
  routeTexts: { flex: 1, paddingBottom: 2 },
  routeLabel: { color: "#98A2B3", fontSize: 8, fontWeight: "800", letterSpacing: 1 },
  routeAddress: { color: "#344054", fontSize: 12, fontWeight: "600", marginTop: 3, marginBottom: 8 },
  destinationLabel: { marginTop: 2 },
  rideMeta: { color: "#8793A2", fontSize: 10, marginTop: 6 },
  assignedRider: { backgroundColor: "#F6F9FB", borderRadius: 10, padding: 10, marginTop: 11 },
  assignedLabel: { color: "#8793A2", fontSize: 8, fontWeight: "800", letterSpacing: 1 },
  assignedName: { color: "#344054", fontSize: 12, fontWeight: "800", marginTop: 4 },
  cancelButton: { alignItems: "center", paddingVertical: 11, marginTop: 4 },
  cancelText: { color: "#B42318", fontWeight: "700", fontSize: 12 },
  emptyState: { backgroundColor: "#FFFFFF", borderRadius: 14, borderWidth: 1, borderColor: "#E5EAF0", padding: 19, alignItems: "center", marginBottom: 13 },
  emptyTitle: { color: "#344054", fontSize: 13, fontWeight: "800" },
  emptyText: { color: "#8793A2", fontSize: 11, textAlign: "center", lineHeight: 17, marginTop: 6 },
  notice: { borderRadius: 10, padding: 11, marginTop: 12 },
  errorNotice: { backgroundColor: "#FEF3F2", borderWidth: 1, borderColor: "#FEE4E2" },
  successNotice: { backgroundColor: "#ECFDF3", borderWidth: 1, borderColor: "#ABEFC6" },
  noticeText: { fontSize: 11, lineHeight: 17 },
  errorNoticeText: { color: "#B42318" },
  successNoticeText: { color: "#067647" },
  statusPill: { alignSelf: "flex-start", backgroundColor: "#FFF4E5", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, marginBottom: 10 },
  statusPillText: { color: "#93370D", fontSize: 10, fontWeight: "800" },
  bodyText: { color: "#667085", fontSize: 13, lineHeight: 20 },
  loadingRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 10 },
  footer: { color: "#98A2B3", fontSize: 10, textAlign: "center", marginTop: 23 }
});
