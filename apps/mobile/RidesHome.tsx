import { forwardRef, useCallback, useEffect, useRef, useState, type ComponentProps, type ComponentRef } from "react";
import * as SecureStore from "expo-secure-store";
import * as Location from "expo-location";
import {
  AppState,
  ActivityIndicator,
  Keyboard,
  Animated,
  Dimensions,
  Image,
  Linking,
  PanResponder,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { StatusBar } from "expo-status-bar";
import NativeMapView, { Marker, Polyline } from "react-native-maps";

type UiAppearance = "LIGHT" | "DARK";
type UiTextSize = "COMPACT" | "STANDARD" | "LARGE";
type UiPreferences = { appearance: UiAppearance; textSize: UiTextSize };
const UI_PREFERENCES_KEY = "navigo.uiPreferences";

// Android uses an OTA-safe raster OpenStreetMap renderer. This avoids
// mounting the native Google Maps view that is not configured in the installed APK.
type OsmRegion = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };
type NativeRegionChangeHandler = NonNullable<ComponentProps<typeof NativeMapView>["onRegionChangeComplete"]>;
type OsmMarker = { coordinate?: RouteCoordinate | null; title?: string; pinColor?: string };
type SafeMapViewProps = Omit<ComponentProps<typeof NativeMapView>, "region" | "initialRegion" | "onRegionChangeComplete"> & {
  region?: OsmRegion;
  initialRegion?: OsmRegion;
  onRegionChangeComplete?: NativeRegionChangeHandler;
  routeCoordinates?: RouteCoordinate[] | null;
  markers?: OsmMarker[];
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
};

const OSM_TILE_SIZE = 256;
const OSM_TILE_URL = "https://tile.openstreetmap.org";
const OSM_TILE_HEADERS = {
  "User-Agent": "NAVIGO/1.0 (+https://github.com/WilberAsingwire/NavigoUg)"
};
const DEFAULT_OSM_REGION: OsmRegion = {
  latitude: 3.02,
  longitude: 30.92,
  latitudeDelta: 0.035,
  longitudeDelta: 0.035
};

function osmCoordinateToPixel(point: RouteCoordinate, zoom: number) {
  const worldSize = OSM_TILE_SIZE * 2 ** zoom;
  const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.latitude));
  const sinLatitude = Math.sin((latitude * Math.PI) / 180);
  return {
    x: ((point.longitude + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * worldSize
  };
}

function osmPixelToCoordinate(point: { x: number; y: number }, zoom: number): RouteCoordinate {
  const worldSize = OSM_TILE_SIZE * 2 ** zoom;
  const longitude = (point.x / worldSize) * 360 - 180;
  const mercatorY = Math.PI - (2 * Math.PI * point.y) / worldSize;
  const latitude = (180 / Math.PI) * Math.atan(Math.sinh(mercatorY));
  return { latitude, longitude };
}

function osmZoomForRegion(region: OsmRegion, width: number) {
  const safeWidth = Math.max(width, 320);
  return Math.max(3, Math.min(19, Math.round(Math.log2((360 * safeWidth) / (OSM_TILE_SIZE * Math.max(region.longitudeDelta, 0.00001))))));
}

function OpenStreetMapRasterView({
  style,
  region,
  initialRegion,
  routeCoordinates,
  markers,
  onRegionChangeComplete,
  onMapReady,
  onInteractionStart,
  onInteractionEnd,
  scrollEnabled,
  zoomEnabled
}: {
  style?: ComponentProps<typeof NativeMapView>["style"];
  region?: OsmRegion;
  initialRegion?: OsmRegion;
  routeCoordinates?: RouteCoordinate[] | null;
  markers?: OsmMarker[];
  onRegionChangeComplete?: NativeRegionChangeHandler;
  onMapReady?: () => void;
  onInteractionStart?: () => void;
  onInteractionEnd?: () => void;
  scrollEnabled?: boolean;
  zoomEnabled?: boolean;
}) {
  const [layout, setLayout] = useState({ width: 0, height: 0 });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [localRegion, setLocalRegion] = useState<OsmRegion>(initialRegion ?? DEFAULT_OSM_REGION);
  const controlledRegionRef = useRef(region !== undefined);
  controlledRegionRef.current = region !== undefined;
  const currentRegion = region ?? localRegion;
  const regionRef = useRef(currentRegion);
  regionRef.current = currentRegion;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const onRegionChangeRef = useRef<NativeRegionChangeHandler | undefined>(onRegionChangeComplete);
  onRegionChangeRef.current = onRegionChangeComplete;
  const applyRegionChange = (nextRegion: OsmRegion) => {
    if (!controlledRegionRef.current) setLocalRegion(nextRegion);
    onRegionChangeRef.current?.(nextRegion, { isGesture: true });
  };
  const zoom = osmZoomForRegion(currentRegion, layout.width || 360);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pinchStartRef = useRef<{ distance: number; zoom: number; region: OsmRegion } | null>(null);
  const pinchLastZoomRef = useRef<number | null>(null);
  const pinchWasUsedRef = useRef(false);
  const readyRef = useRef(false);
  const centerPixel = osmCoordinateToPixel(currentRegion, zoom);
  const worldTileCount = 2 ** zoom;

  const startPinch = (touches: ReadonlyArray<{ pageX: number; pageY: number }>) => {
    const first = touches[0];
    const second = touches[1];
    if (!first || !second) return;
    const distance = Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY);
    if (!Number.isFinite(distance) || distance < 8) return;
    pinchStartRef.current = {
      distance,
      zoom: zoomRef.current,
      region: regionRef.current
    };
    pinchLastZoomRef.current = zoomRef.current;
    pinchWasUsedRef.current = true;
  };

  const panResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponderCapture: (event, gesture) =>
      scrollEnabled !== false && (
        event.nativeEvent.touches.length >= 2 ||
        Math.abs(gesture.dx) > 7 ||
        Math.abs(gesture.dy) > 7
      ),
    onMoveShouldSetPanResponder: (event, gesture) =>
      scrollEnabled !== false && (
        event.nativeEvent.touches.length >= 2 ||
        Math.abs(gesture.dx) > 7 ||
        Math.abs(gesture.dy) > 7
      ),
    onPanResponderGrant: (event) => {
      setDragOffset({ x: 0, y: 0 });
      pinchStartRef.current = null;
      pinchLastZoomRef.current = null;
      pinchWasUsedRef.current = false;
      if (event.nativeEvent.touches.length >= 2) {
        startPinch(event.nativeEvent.touches);
      }
    },
    onPanResponderMove: (event, gesture) => {
      const touches = event.nativeEvent.touches;
      if (touches.length >= 2) {
        // Two fingers control zoom. The integer tile zoom changes as the
        // pinch crosses each level, and the map stays centred on the route.
        setDragOffset({ x: 0, y: 0 });
        if (!pinchStartRef.current) startPinch(touches);
        const pinch = pinchStartRef.current;
        const first = touches[0];
        const second = touches[1];
        if (!pinch || !first || !second) return;
        const distance = Math.hypot(second.pageX - first.pageX, second.pageY - first.pageY);
        if (!Number.isFinite(distance) || distance < 8) return;
        const scale = distance / pinch.distance;
        const targetZoom = Math.max(3, Math.min(19, Math.round(pinch.zoom + Math.log2(scale))));
        if (targetZoom !== pinchLastZoomRef.current) {
          const factor = 2 ** (pinch.zoom - targetZoom);
          applyRegionChange({
            ...pinch.region,
            latitudeDelta: Math.max(0.001, pinch.region.latitudeDelta * factor),
            longitudeDelta: Math.max(0.001, pinch.region.longitudeDelta * factor)
          });
          pinchLastZoomRef.current = targetZoom;
        }
        return;
      }

      if (pinchWasUsedRef.current) {
        setDragOffset({ x: 0, y: 0 });
        return;
      }

      // One finger moves the visible tile layer with the finger immediately.
      setDragOffset({ x: gesture.dx, y: gesture.dy });
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_event, gesture) => {
      const size = layoutRef.current;
      const moved = Math.abs(gesture.dx) >= 3 || Math.abs(gesture.dy) >= 3;
      if (!pinchWasUsedRef.current && size.width > 0 && size.height > 0 && moved) {
        const activeZoom = zoomRef.current;
        const oldCenter = osmCoordinateToPixel(regionRef.current, activeZoom);
        const nextCenter = {
          x: oldCenter.x - gesture.dx,
          y: oldCenter.y - gesture.dy
        };
        const nextCoordinate = osmPixelToCoordinate(nextCenter, activeZoom);
        const north = osmPixelToCoordinate({ x: nextCenter.x, y: nextCenter.y - size.height / 2 }, activeZoom);
        const south = osmPixelToCoordinate({ x: nextCenter.x, y: nextCenter.y + size.height / 2 }, activeZoom);
        applyRegionChange({
          latitude: nextCoordinate.latitude,
          longitude: nextCoordinate.longitude,
          latitudeDelta: Math.max(0.001, Math.abs(north.latitude - south.latitude)),
          longitudeDelta: Math.max(0.001, (size.width / (OSM_TILE_SIZE * 2 ** activeZoom)) * 360)
        });
      }
      pinchStartRef.current = null;
      pinchLastZoomRef.current = null;
      pinchWasUsedRef.current = false;
      setDragOffset({ x: 0, y: 0 });
    },
    onPanResponderTerminate: () => {
      pinchStartRef.current = null;
      pinchLastZoomRef.current = null;
      pinchWasUsedRef.current = false;
      setDragOffset({ x: 0, y: 0 });
    }
  })).current;

  const tiles: Array<{ key: string; uri: string; left: number; top: number }> = [];
  if (layout.width > 0 && layout.height > 0) {
    // One tile of short-range look-ahead keeps the viewport covered while a
    // user pans, without prefetching areas outside normal map interaction.
    const minTileX = Math.floor((centerPixel.x - layout.width / 2) / OSM_TILE_SIZE) - 1;
    const maxTileX = Math.floor((centerPixel.x + layout.width / 2) / OSM_TILE_SIZE) + 1;
    const minTileY = Math.floor((centerPixel.y - layout.height / 2) / OSM_TILE_SIZE) - 1;
    const maxTileY = Math.floor((centerPixel.y + layout.height / 2) / OSM_TILE_SIZE) + 1;
    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      if (tileY < 0 || tileY >= worldTileCount) continue;
      for (let unwrappedTileX = minTileX; unwrappedTileX <= maxTileX; unwrappedTileX += 1) {
        const tileX = ((unwrappedTileX % worldTileCount) + worldTileCount) % worldTileCount;
        tiles.push({
          key: zoom + "/" + tileX + "/" + tileY,
          uri: OSM_TILE_URL + "/" + zoom + "/" + tileX + "/" + tileY + ".png",
          left: unwrappedTileX * OSM_TILE_SIZE - centerPixel.x + layout.width / 2,
          top: tileY * OSM_TILE_SIZE - centerPixel.y + layout.height / 2
        });
      }
    }
  }

  const toScreenPoint = (coordinate: RouteCoordinate) => {
    const pixel = osmCoordinateToPixel(coordinate, zoom);
    return {
      x: pixel.x - centerPixel.x + layout.width / 2,
      y: pixel.y - centerPixel.y + layout.height / 2
    };
  };

  const routePoints = routeCoordinates?.length
    ? routeCoordinates.filter((_point, index) => {
        const stride = Math.max(1, Math.ceil(routeCoordinates.length / 120));
        return index % stride === 0 || index === routeCoordinates.length - 1;
      }).map(toScreenPoint)
    : [];
  const validMarkers = (markers ?? []).filter(
    (marker): marker is OsmMarker & { coordinate: RouteCoordinate } => Boolean(marker.coordinate)
  );

  const changeZoom = (amount: number) => {
    const nextZoom = Math.max(3, Math.min(19, zoom + amount));
    if (nextZoom === zoom) return;
    const factor = 2 ** (zoom - nextZoom);
    applyRegionChange({
      ...currentRegion,
      latitudeDelta: Math.max(0.001, currentRegion.latitudeDelta * factor),
      longitudeDelta: Math.max(0.001, currentRegion.longitudeDelta * factor)
    });
  };

  return (
    <View
      style={[style, { overflow: "hidden", backgroundColor: "#E8F0F4" }]}
      onLayout={(event) => {
        const next = {
          width: event.nativeEvent.layout.width,
          height: event.nativeEvent.layout.height
        };
        setLayout((previous) =>
          previous.width === next.width && previous.height === next.height ? previous : next
        );
        if (!readyRef.current) {
          readyRef.current = true;
          onMapReady?.();
        }
      }}
      onTouchStart={onInteractionStart}
      onTouchEnd={(event) => {
        if (event.nativeEvent.touches.length === 0) onInteractionEnd?.();
      }}
      onTouchCancel={onInteractionEnd}
      {...panResponder.panHandlers}
    >
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          transform: [{ translateX: dragOffset.x }, { translateY: dragOffset.y }]
        }}
      >
      {tiles.map((tile) => (
        <Image
          key={tile.key}
          source={{ uri: tile.uri, headers: OSM_TILE_HEADERS }}
          resizeMode="stretch"
          fadeDuration={0}
          style={{
            position: "absolute",
            left: tile.left,
            top: tile.top,
            width: OSM_TILE_SIZE,
            height: OSM_TILE_SIZE
          }}
        />
      ))}
      {routePoints.slice(1).map((point, index) => {
        const previous = routePoints[index];
        if (!previous) return null;
        const dx = point.x - previous.x;
        const dy = point.y - previous.y;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (!Number.isFinite(length) || length < 1) return null;
        return (
          <View
            key={"route-" + index}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: (previous.x + point.x - length) / 2,
              top: (previous.y + point.y) / 2 - 2.5,
              width: length,
              height: 5,
              borderRadius: 3,
              backgroundColor: "#1F76A8",
              transform: [{ rotate: Math.atan2(dy, dx) + "rad" }]
            }}
          />
        );
      })}
      {validMarkers.map((marker, index) => {
        const point = toScreenPoint(marker.coordinate);
        if (point.x < -40 || point.x > layout.width + 40 || point.y < -50 || point.y > layout.height + 40) return null;
        return (
          <View
            key={"marker-" + index}
            pointerEvents="none"
            style={{
              position: "absolute",
              left: point.x - 9,
              top: point.y - 19,
              alignItems: "center"
            }}
          >
            <View
              style={{
                width: 18,
                height: 18,
                borderRadius: 9,
                backgroundColor: marker.pinColor ?? "#236B9A",
                borderColor: "#FFFFFF",
                borderWidth: 2,
                elevation: 4
              }}
            />
            {marker.title ? (
              <View style={{ backgroundColor: "#FFFFFF", borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2, marginTop: 2, elevation: 2 }}>
                <Text style={{ color: "#344054", fontSize: 8, fontWeight: "800" }}>{marker.title}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
      </View>
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          right: 7,
          bottom: 7,
          backgroundColor: "rgba(255,255,255,0.92)",
          borderRadius: 5,
          paddingHorizontal: 6,
          paddingVertical: 3
        }}
      >
        <Text style={{ color: "#344054", fontSize: 8, fontWeight: "700" }}>© OpenStreetMap contributors</Text>
      </View>
      {zoomEnabled !== false ? (
        <View style={{ position: "absolute", left: 12, top: 118, backgroundColor: "#FFFFFF", borderRadius: 13, elevation: 7, overflow: "hidden", zIndex: 10, borderWidth: 1, borderColor: "#DCE3EB" }}>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Zoom in" onPress={() => changeZoom(1)} style={{ width: 48, height: 46, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#174A72", fontSize: 28, fontWeight: "800", lineHeight: 32 }}>+</Text>
          </TouchableOpacity>
          <View style={{ height: 1, backgroundColor: "#E5EAF0" }} />
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Zoom out" onPress={() => changeZoom(-1)} style={{ width: 48, height: 46, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#174A72", fontSize: 28, fontWeight: "800", lineHeight: 32 }}>−</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const SafeMapView = forwardRef<ComponentRef<typeof NativeMapView>, SafeMapViewProps>(
  function SafeMapView({ routeCoordinates, markers, onInteractionStart, onInteractionEnd, children, style, region, initialRegion, ...nativeProps }, ref) {
    if (Platform.OS === "android") {
      return (
        <OpenStreetMapRasterView
          style={style}
          region={region}
          initialRegion={initialRegion}
          routeCoordinates={routeCoordinates}
          markers={markers}
          onRegionChangeComplete={nativeProps.onRegionChangeComplete}
          onMapReady={nativeProps.onMapReady}
          onInteractionStart={onInteractionStart}
          onInteractionEnd={onInteractionEnd}
          scrollEnabled={nativeProps.scrollEnabled}
          zoomEnabled={nativeProps.zoomEnabled}
        />
      );
    }

    return (
      <NativeMapView
        ref={ref}
        style={style}
        region={region}
        initialRegion={initialRegion}
        {...nativeProps}
      >
        {children}
      </NativeMapView>
    );
  }
);

SafeMapView.displayName = "SafeMapView";
type Session = {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: {
    id: string;
    fullName: string;
    phone: string;
    email?: string | null;
    role: "CUSTOMER" | "RIDER" | "ADMIN";
    availableRoles?: Array<"CUSTOMER" | "RIDER" | "ADMIN">;
    riderProfile?: { licenceNumber: string | null; motorcyclePlate: string | null; motorcycleDescription: string | null } | null;
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
  pickupDistanceKm?: number | null;
  pickupLatitude?: number | string;
  pickupLongitude?: number | string;
  destinationLatitude?: number | string;
  destinationLongitude?: number | string;
  routeCoordinates?: RouteCoordinate[] | null;
  estimatedDurationSeconds?: number | null;
  routingProvider?: "GOOGLE_TWO_WHEELER" | "VALHALLA_MOTORCYCLE" | null;
  riderArrivalEstimateMinutes?: number | null;
  riderArrivalEstimateUpdatedAt?: string | null;
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
  quoteToken: string;
  fareAmountUgx: number;
  distanceKm: number;
  fareBasis: "LANDMARK_FARE" | "DISTANCE_RULE";
  durationSeconds: number;
  routeCoordinates: RouteCoordinate[];
  routingProvider: "GOOGLE_TWO_WHEELER" | "VALHALLA_MOTORCYCLE";
};

function coordinateFromValues(latitude: number | string | undefined, longitude: number | string | undefined): RouteCoordinate | null {
  if (latitude === undefined || longitude === undefined) return null;
  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);
  if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude) || parsedLatitude < -90 || parsedLatitude > 90 || parsedLongitude < -180 || parsedLongitude > 180) return null;
  return { latitude: parsedLatitude, longitude: parsedLongitude };
}

function routeCoordinatesFromUnknown(value: unknown): RouteCoordinate[] | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 500) return null;
  const coordinates: RouteCoordinate[] = [];
  for (const point of value) {
    if (typeof point !== "object" || point === null || Array.isArray(point)) return null;
    const candidate = point as { latitude?: unknown; longitude?: unknown };
    const latitude = Number(candidate.latitude);
    const longitude = Number(candidate.longitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -90 || latitude > 90 ||
      longitude < -180 || longitude > 180
    ) return null;
    coordinates.push({ latitude, longitude });
  }
  return coordinates;
}

function routeMapRegion(coordinates: RouteCoordinate[], bottomSheetInset = 0) {
  const validCoordinates = coordinates.filter((point) =>
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    point.latitude >= -85.05112878 &&
    point.latitude <= 85.05112878 &&
    point.longitude >= -180 &&
    point.longitude <= 180
  );
  if (validCoordinates.length < 2) return DEFAULT_OSM_REGION;

  const latitudes = validCoordinates.map((point) => point.latitude);
  const longitudes = validCoordinates.map((point) => point.longitude);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const baseRegion: OsmRegion = {
    latitude: (minLatitude + maxLatitude) / 2,
    longitude: (minLongitude + maxLongitude) / 2,
    latitudeDelta: Math.max(0.008, (maxLatitude - minLatitude) * 1.7),
    longitudeDelta: Math.max(0.008, (maxLongitude - minLongitude) * 1.7)
  };

  if (bottomSheetInset <= 0) return baseRegion;

  // Shift the map centre slightly south so the route sits in the visible map
  // area above the fare review panel instead of underneath the panel.
  const zoom = osmZoomForRegion(baseRegion, Dimensions.get("window").width);
  const centerPixel = osmCoordinateToPixel(baseRegion, zoom);
  const adjustedCenter = osmPixelToCoordinate({
    x: centerPixel.x,
    y: centerPixel.y + bottomSheetInset / 2
  }, zoom);
  return { ...baseRegion, latitude: adjustedCenter.latitude };
}

type ParcelSize = "SMALL" | "MEDIUM" | "LARGE";
type ParcelQuote = {
  fareAmountUgx: number;
  distanceKm: number;
  durationSeconds: number;
  routeCoordinates: RouteCoordinate[];
  routingProvider: "GOOGLE_TWO_WHEELER" | "VALHALLA_MOTORCYCLE";
};
type ParcelRequest = {
  id: string;
  pickupCode: string;
  deliveryCode: string;
  fareAmountUgx: number;
  estimatedDistanceKm: number;
  status: string;
};

type RiderParcel = {
  id: string;
  status: string;
  pickupDescription: string;
  destinationDescription: string;
  recipientName: string;
  recipientPhone?: string;
  parcelDescription: string;
  sizeCategory: ParcelSize;
  pickupLatitude?: number | string;
  pickupLongitude?: number | string;
  destinationLatitude?: number | string;
  destinationLongitude?: number | string;
  fareAmountUgx: number;
  estimatedDistanceKm: number | string | null;
  createdAt: string;
  sender?: { fullName: string; phone?: string } | null;
  rider?: { fullName: string; phone?: string; riderProfile?: { motorcyclePlate?: string | null } | null } | null;
  payment?: { method: PaymentMethod; status: "UNPAID" | "PAID" } | null;
  history?: { id: string; fromStatus: string | null; toStatus: string; note?: string | null; createdAt: string }[];
};

type ParcelTracking = {
  parcelId: string;
  status: string;
  pickup: RouteCoordinate;
  destination: RouteCoordinate;
  rider: (RouteCoordinate & { accuracyMeters: number; updatedAt: string }) | null;
  sharingEnabled: boolean;
};

type AdminRider = {
  userId: string;
  approvalStatus: "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED";
  licenceNumber: string | null;
  motorcyclePlate: string | null;
  motorcycleDescription: string | null;
  rejectionReason: string | null;
  createdAt: string;
  user: {
    id: string;
    fullName: string;
    phone: string;
    email: string | null;
    isActive: boolean;
    createdAt: string;
  };
};

type AdminFareRule = {
  id: string;
  requestType: "RIDE" | "PARCEL";
  parcelSize: ParcelSize | null;
  minDistanceKm: number | string;
  maxDistanceKm: number | string | null;
  fareUgx: number;
  isActive: boolean;
};

const ACTIVE_TRACKING_STATUSES = [
  "ACCEPTED",
  "ARRIVED_AT_PICKUP",
  "COLLECTED",
  "IN_TRANSIT",
  "ARRIVED_AT_DESTINATION"
];


type WorkspaceTab = "home" | "activity" | "requests" | "jobs" | "profile";

type Props = {
  session: Session;
  onSignOut: () => void;
  onSessionChange: (session: Session) => void;
  signingOut: boolean;
};

const API_BASE_URL = "https://navigou-api-2978.onrender.com";
const STATUS_LABELS: Record<string, string> = {
  PENDING: "Finding a nearby rider",
  ACCEPTED: "Your rider is on the way",
  ARRIVED_AT_PICKUP: "Your rider has arrived",
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

async function geocodeAruaAddress(
  value: string,
  accessToken: string,
  refreshAccessToken: () => Promise<string>
): Promise<RideLocation> {
  const trimmed = value.trim();
  if (trimmed.length < 3) throw new Error("Enter a pickup or destination address.");

  const result = await apiRequest<{ data: RideLocation }>(
    "/api/v1/rides/geocode",
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({ query: trimmed })
    },
    refreshAccessToken
  );

  return {
    ...result.data,
    description: result.data.description || trimmed
  };
}

export default function RidesHome({ session, onSignOut, onSessionChange, signingOut }: Props) {
  const [activeSession, setActiveSession] = useState(session);

  useEffect(() => {
    setActiveSession(session);
  }, [session]);
  const [mainTab, setMainTab] = useState<WorkspaceTab>("home");
  const [appearance, setAppearance] = useState<UiAppearance>("LIGHT");
  const [textSize, setTextSize] = useState<UiTextSize>("STANDARD");
  const isCustomer = activeSession.user.role === "CUSTOMER";

  useEffect(() => {
    let mounted = true;
    SecureStore.getItemAsync(UI_PREFERENCES_KEY).then((stored) => {
      if (!stored) return;
      const parsed = JSON.parse(stored) as Partial<UiPreferences>;
      const nextAppearance: UiAppearance = parsed.appearance === "DARK" ? "DARK" : "LIGHT";
      const nextTextSize: UiTextSize = parsed.textSize === "COMPACT" || parsed.textSize === "LARGE"
        ? parsed.textSize
        : "STANDARD";
      if (!mounted) return;
      styles = createAppStyles(nextAppearance, nextTextSize);
      setAppearance(nextAppearance);
      setTextSize(nextTextSize);
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const updateUiPreferences = useCallback(async (changes: Partial<UiPreferences>) => {
    const next: UiPreferences = {
      appearance: changes.appearance ?? appearance,
      textSize: changes.textSize ?? textSize
    };
    styles = createAppStyles(next.appearance, next.textSize);
    setAppearance(next.appearance);
    setTextSize(next.textSize);
    await SecureStore.setItemAsync(UI_PREFERENCES_KEY, JSON.stringify(next)).catch(() => undefined);
  }, [appearance, textSize]);
  const isApprovedRider = activeSession.user.role === "RIDER" && activeSession.user.riderApprovalStatus === "APPROVED";
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
      onSessionChange(renewedSession);
      return renewedSession.accessToken;
    })();

    refreshInFlight.current = pending;
    try {
      return await pending;
    } finally {
      if (refreshInFlight.current === pending) refreshInFlight.current = null;
    }
  }, [onSignOut, onSessionChange]);

  const saveOwnProfile = useCallback(async (input: { fullName: string; email: string }) => {
    const result = await apiRequest<{ data: Session["user"] }>(
      "/api/v1/auth/me",
      activeSession.accessToken,
      {
        method: "PATCH",
        body: JSON.stringify(input)
      },
      refreshAccessToken
    );
    const updatedSession = { ...activeSession, user: result.data };
    await SecureStore.setItemAsync("navigo.session", JSON.stringify(updatedSession));
    setActiveSession(updatedSession);
    onSessionChange(updatedSession);
  }, [activeSession, refreshAccessToken, onSessionChange]);

  const changeOwnPassword = useCallback(async (input: { currentPassword: string; newPassword: string }) => {
    const result = await apiRequest<{ data: Session }>(
      "/api/v1/auth/change-password",
      activeSession.accessToken,
      {
        method: "POST",
        body: JSON.stringify(input)
      },
      refreshAccessToken
    );
    await SecureStore.setItemAsync("navigo.session", JSON.stringify(result.data));
    setActiveSession(result.data);
    onSessionChange(result.data);
  }, [activeSession.accessToken, refreshAccessToken, onSessionChange]);

  const switchWorkspace = useCallback(async (role: "CUSTOMER" | "RIDER") => {
    const result = await apiRequest<{ data: Session }>(
      "/api/v1/auth/switch-workspace",
      activeSession.accessToken,
      { method: "POST", body: JSON.stringify({ role }) },
      refreshAccessToken
    );
    await SecureStore.setItemAsync("navigo.session", JSON.stringify(result.data));
    setActiveSession(result.data);
    onSessionChange(result.data);
    setMainTab("home");
  }, [activeSession.accessToken, refreshAccessToken, onSessionChange]);

  const applyForRider = useCallback(async (input: {
    licenceNumber: string; motorcyclePlate: string; motorcycleDescription: string;
  }) => {
    const result = await apiRequest<{ data: Session["user"] }>(
      "/api/v1/auth/apply-rider",
      activeSession.accessToken,
      { method: "POST", body: JSON.stringify(input) },
      refreshAccessToken
    );
    const updatedSession = { ...activeSession, user: result.data };
    await SecureStore.setItemAsync("navigo.session", JSON.stringify(updatedSession));
    setActiveSession(updatedSession);
    onSessionChange(updatedSession);
  }, [activeSession, refreshAccessToken, onSessionChange]);

  const [tab, setTab] = useState<"book" | "parcel">("book");
  const [customerActivityTab, setCustomerActivityTab] = useState<"rides" | "parcels">("rides");
  const [riderRequestTab, setRiderRequestTab] = useState<"rides" | "parcels">("rides");
  const [riderJobTab, setRiderJobTab] = useState<"rides" | "parcels">("rides");
  const [pickup, setPickup] = useState("");
  const [destination, setDestination] = useState("");
  const pickupInputRef = useRef<ComponentRef<typeof TextInput> | null>(null);
  const destinationInputRef = useRef<ComponentRef<typeof TextInput> | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [locations, setLocations] = useState<{ pickup: RideLocation; destination: RideLocation } | null>(null);
  const [selectedPickupLocation, setSelectedPickupLocation] = useState<RideLocation | null>(null);
  const [selectedDestinationLocation, setSelectedDestinationLocation] = useState<RideLocation | null>(null);
  const [selectedPickupSearchQuery, setSelectedPickupSearchQuery] = useState("");
  const [selectedDestinationSearchQuery, setSelectedDestinationSearchQuery] = useState("");
  const [rides, setRides] = useState<Ride[]>([]);
  const [availableRides, setAvailableRides] = useState<Ride[]>([]);
  const observedAvailableRideIds = useRef(new Set<string>());
  const [riderOnline, setRiderOnline] = useState(false);
  const [riderDeviceLocation, setRiderDeviceLocation] = useState<RideLocation | null>(null);
  const [availableParcels, setAvailableParcels] = useState<RiderParcel[]>([]);
  const [assignedParcels, setAssignedParcels] = useState<RiderParcel[]>([]);
  const [sentParcels, setSentParcels] = useState<RiderParcel[]>([]);
  const hasActiveCustomerRides = isCustomer && rides.some((ride) => !["COMPLETED", "CANCELLED", "EXPIRED"].includes(ride.status));
  const activeRiderRide = rides.find((ride) => ["ACCEPTED", "ARRIVED_AT_PICKUP", "IN_PROGRESS"].includes(ride.status));
  const activeRiderRideNextStatus = activeRiderRide ? NEXT_RIDER_STATUS[activeRiderRide.status] : undefined;
  const activeRiderParcel = assignedParcels.find((parcel) => ["ACCEPTED", "ARRIVED_AT_PICKUP", "COLLECTED", "IN_TRANSIT", "ARRIVED_AT_DESTINATION"].includes(parcel.status));
  const riderMapPickup = activeRiderRide
    ? coordinateFromValues(activeRiderRide.pickupLatitude, activeRiderRide.pickupLongitude)
    : activeRiderParcel
      ? coordinateFromValues(activeRiderParcel.pickupLatitude, activeRiderParcel.pickupLongitude)
      : null;
  const riderMapDestination = activeRiderRide
    ? coordinateFromValues(activeRiderRide.destinationLatitude, activeRiderRide.destinationLongitude)
    : activeRiderParcel
      ? coordinateFromValues(activeRiderParcel.destinationLatitude, activeRiderParcel.destinationLongitude)
      : null;
  // New ride requests carry the exact motorcycle route used for the customer's
  // quote. Older rides have no historical snapshot, so we show their endpoints
  // without drawing a misleading straight-line "road route".
  const riderMapStoredRoute = activeRiderRide
    ? routeCoordinatesFromUnknown(activeRiderRide.routeCoordinates)
    : null;
  const riderMapRouteCoordinates = activeRiderRide
    ? riderMapStoredRoute
    : riderMapPickup && riderMapDestination
      ? [riderMapPickup, riderMapDestination]
      : null;
  const riderMapJobKey = activeRiderRide?.id ?? activeRiderParcel?.id ?? null;
  const riderMapNavigationTarget = activeRiderRide
    ? activeRiderRide.status === "ACCEPTED" ? riderMapPickup : riderMapDestination
    : activeRiderParcel
      ? ["ACCEPTED", "ARRIVED_AT_PICKUP"].includes(activeRiderParcel.status) ? riderMapPickup : riderMapDestination
      : null;
  const [parcelCodeInputs, setParcelCodeInputs] = useState<Record<string, string>>({});
  const [ridePaymentReferences, setRidePaymentReferences] = useState<Record<string, string>>({});
  const [parcelPaymentReferences, setParcelPaymentReferences] = useState<Record<string, string>>({});
  const [parcelTrackings, setParcelTrackings] = useState<Record<string, ParcelTracking>>({});
  const [trackingParcelIds, setTrackingParcelIds] = useState<string[]>([]);
  const [adminRiders, setAdminRiders] = useState<AdminRider[]>([]);
  const [adminFareRules, setAdminFareRules] = useState<AdminFareRule[]>([]);
  const [adminRiderFilter, setAdminRiderFilter] = useState<"ALL" | "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED">("PENDING");
  const [adminTab, setAdminTab] = useState<"riders" | "fares">("riders");
  const [adminReviewReason, setAdminReviewReason] = useState("");
  const [fareRequestType, setFareRequestType] = useState<"RIDE" | "PARCEL">("PARCEL");
  const [fareSize, setFareSize] = useState<ParcelSize>("SMALL");
  const [fareMinDistance, setFareMinDistance] = useState("");
  const [fareMaxDistance, setFareMaxDistance] = useState("");
  const [fareAmount, setFareAmount] = useState("");
  const [editingFareRuleId, setEditingFareRuleId] = useState<string | null>(null);
  const [editingFareRuleActive, setEditingFareRuleActive] = useState(true);
  const [parcelSize, setParcelSize] = useState<ParcelSize>("SMALL");
  const [recipientName, setRecipientName] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [parcelQuote, setParcelQuote] = useState<ParcelQuote | null>(null);
  const [parcelLocations, setParcelLocations] = useState<{ pickup: RideLocation; destination: RideLocation } | null>(null);
  const [createdParcel, setCreatedParcel] = useState<ParcelRequest | null>(null);

  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [activeLocationField, setActiveLocationField] = useState<"pickup" | "destination" | null>(null);

  function focusLocationField(field: "pickup" | "destination") {
    setActiveLocationField(field);
    setMapSheetExpanded(true);
  }

  function selectLocationSuggestion(field: "pickup" | "destination", suggestion: LocationSuggestion) {
    const selectedPoint: RideLocation | null =
      suggestion.latitude !== undefined && suggestion.longitude !== undefined
        ? {
            latitude: suggestion.latitude,
            longitude: suggestion.longitude,
            description: suggestion.label
          }
        : null;

    const nextPickup = field === "pickup" ? suggestion.label : pickup;
    const nextDestination = field === "destination" ? suggestion.label : destination;
    const nextPickupPoint = field === "pickup" ? selectedPoint : selectedPickupLocation;
    const nextDestinationPoint = field === "destination" ? selectedPoint : selectedDestinationLocation;

    if (field === "pickup") {
      setPickup(suggestion.label);
      setSelectedPickupLocation(selectedPoint);
      setSelectedPickupSearchQuery(suggestion.searchQuery ?? "");
      setQuote(null);
      setLocations(null);
      setParcelQuote(null);
      setParcelLocations(null);
    } else {
      setDestination(suggestion.label);
      setSelectedDestinationLocation(selectedPoint);
      setSelectedDestinationSearchQuery(suggestion.searchQuery ?? "");
      setQuote(null);
      setLocations(null);
      setParcelQuote(null);
      setParcelLocations(null);
    }

    const otherPlaceIsReady = field === "pickup" ? Boolean(destination.trim()) : Boolean(pickup.trim());
    if (otherPlaceIsReady) {
      setActiveLocationField(null);
      setMapSheetExpanded(true);
      Keyboard.dismiss();
      const overrides = {
        pickup: nextPickupPoint,
        destination: nextDestinationPoint,
        pickupText: nextPickup,
        destinationText: nextDestination
      };
      if (tab === "parcel") void getParcelFareEstimate(overrides);
      else void getFareEstimate(overrides);
      return;
    }

    const nextField = field === "pickup" ? "destination" : "pickup";
    setActiveLocationField(nextField);
    setMapSheetExpanded(true);
    requestAnimationFrame(() => {
      if (nextField === "pickup") pickupInputRef.current?.focus();
      else destinationInputRef.current?.focus();
    });
  }
  const [deviceLocation, setDeviceLocation] = useState<RideLocation | null>(null);
  const [locationStatus, setLocationStatus] = useState<"locating" | "ready" | "denied" | "unavailable">("locating");
  const riderMapRef = useRef<ComponentRef<typeof NativeMapView> | null>(null);
  const pendingRiderMapCenter = useRef<RideLocation | null>(null);
  const riderMapCentering = useRef(false);
  const [riderMapReady, setRiderMapReady] = useState(false);
  const [riderMapCenteringUi, setRiderMapCenteringUi] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [mapGestureActive, setMapGestureActive] = useState(false);
  const locationDetectionStarted = useRef(false);
  const [mapRegion, setMapRegion] = useState({
    latitude: 3.02,
    longitude: 30.92,
    latitudeDelta: 0.035,
    longitudeDelta: 0.035
  });
  const mapSheetCollapsedHeight = 168;
  const mapSheetExpandedHeight = Math.min(Dimensions.get("window").height * 0.60, 520);
  const mapSheetSearchHeight = Math.min(Dimensions.get("window").height * 0.84, 680);
  const mapSheetRouteReviewHeight = Math.min(Dimensions.get("window").height * 0.46, 390);
  const [mapSheetExpanded, setMapSheetExpanded] = useState(true);
  const mapSheetHeight = useRef(new Animated.Value(mapSheetCollapsedHeight)).current;
  const mapSheetTargetHeight = activeLocationField !== null
    ? mapSheetSearchHeight
    : (quote && locations) || (parcelQuote && parcelLocations)
      ? mapSheetRouteReviewHeight
      : mapSheetExpanded ? mapSheetExpandedHeight : mapSheetCollapsedHeight;
  const mapSheetPanResponder = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => false,
    onMoveShouldSetPanResponder: (_event, gesture) => Math.abs(gesture.dy) > 8,
    onPanResponderRelease: (_event, gesture) => {
      if (gesture.dy < -30) setMapSheetExpanded(true);
      else if (gesture.dy > 30) setMapSheetExpanded(false);
    }
  })).current;

  useEffect(() => {
    const animation = Animated.spring(mapSheetHeight, {
      toValue: mapSheetTargetHeight,
      useNativeDriver: false,
      tension: 64,
      friction: 13
    });
    animation.start();
    return () => animation.stop();
  }, [mapSheetTargetHeight, mapSheetHeight]);

  useEffect(() => {
    if (activeSession.user.role === "RIDER" && mainTab !== "home") {
      setRiderMapReady(false);
    }
  }, [activeSession.user.role, mainTab]);

  useEffect(() => {
    const showSubscription = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hideSubscription = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      showSubscription.remove();
      hideSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!isApprovedRider || mainTab !== "home" || !riderMapPickup || !riderMapDestination) return;
    setMapRegion(routeMapRegion(riderMapStoredRoute ?? [riderMapPickup, riderMapDestination]));
  }, [isApprovedRider, mainTab, riderMapJobKey, riderMapPickup?.latitude, riderMapPickup?.longitude, riderMapDestination?.latitude, riderMapDestination?.longitude, activeRiderRide?.routeCoordinates]);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError("");
    if (activeSession.user.role === "ADMIN") {
      try {
        const riderQuery = adminRiderFilter === "ALL" ? "" : `?status=${adminRiderFilter}`;
        const [riderResult, fareResult] = await Promise.all([
          apiRequest<{ data: AdminRider[] }>(`/api/v1/admin/riders${riderQuery}`, activeSession.accessToken, undefined, refreshAccessToken),
          apiRequest<{ data: AdminFareRule[] }>("/api/v1/admin/fare-rules", activeSession.accessToken, undefined, refreshAccessToken)
        ]);
        setAdminRiders(riderResult.data ?? []);
        setAdminFareRules(fareResult.data ?? []);
        setRides([]);
        setAvailableRides([]);
        setAvailableParcels([]);
        setAssignedParcels([]);
        setSentParcels([]);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unable to load administrator data.");
      } finally {
        setLoading(false);
      }
      return;
    }
    try {
      const mine = await apiRequest<{ data: Ride[] }>("/api/v1/rides/mine", activeSession.accessToken, undefined, refreshAccessToken);
      setRides(mine.data ?? []);
      if (isApprovedRider) {
        if (riderOnline) {
          const available = await apiRequest<{ data: Ride[] }>("/api/v1/rides/available", activeSession.accessToken, undefined, refreshAccessToken);
          setAvailableRides(available.data ?? []);
        } else {
          setAvailableRides([]);
        }
        const [parcelQueue, myParcels] = await Promise.all([
          apiRequest<{ data: RiderParcel[] }>("/api/v1/parcels/available", activeSession.accessToken, undefined, refreshAccessToken),
          apiRequest<{ data: RiderParcel[] }>("/api/v1/parcels/mine", activeSession.accessToken, undefined, refreshAccessToken)
        ]);
        setAvailableParcels(parcelQueue.data ?? []);
        setAssignedParcels(myParcels.data ?? []);
        setSentParcels([]);
      } else if (activeSession.user.role === "CUSTOMER") {
        const mine = await apiRequest<{ data: RiderParcel[] }>("/api/v1/parcels/mine", activeSession.accessToken, undefined, refreshAccessToken);
        setSentParcels(mine.data ?? []);
        setAvailableParcels([]);
        setAssignedParcels([]);
      } else {
        setAvailableRides([]);
        setAvailableParcels([]);
        setAssignedParcels([]);
        setSentParcels([]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load your rides.");
    } finally {
      setLoading(false);
    }
  }, [activeSession.accessToken, activeSession.user.role, isApprovedRider, riderOnline, adminRiderFilter, refreshAccessToken]);

  const refreshAvailableRides = useCallback(async () => {
    if (!isApprovedRider || !riderOnline) return;
    try {
      const available = await apiRequest<{ data: Ride[] }>("/api/v1/rides/available", activeSession.accessToken, undefined, refreshAccessToken);
      setAvailableRides(available.data ?? []);
    } catch {
      // Keep the last confirmed queue visible; the next poll will retry.
    }
  }, [isApprovedRider, riderOnline, activeSession.accessToken, refreshAccessToken]);

  useEffect(() => { void loadDashboard(); }, [loadDashboard]);

  useEffect(() => {
    if (!isApprovedRider || !riderOnline) return undefined;
    void refreshAvailableRides();
    const timer = setInterval(() => void refreshAvailableRides(), 10_000);
    return () => clearInterval(timer);
  }, [isApprovedRider, riderOnline, refreshAvailableRides]);

  useEffect(() => {
    if (!isApprovedRider || !riderOnline || activeRiderRide || availableRides.length === 0) return;
    const hasUnseenRide = availableRides.some((ride) => !observedAvailableRideIds.current.has(ride.id));
    availableRides.forEach((ride) => observedAvailableRideIds.current.add(ride.id));
    if (hasUnseenRide && mainTab === "home") {
      setRiderRequestTab("rides");
      setMainTab("requests");
      setMessage("A new nearby ride request is waiting for you.");
    }
  }, [isApprovedRider, riderOnline, activeRiderRide?.id, availableRides, mainTab]);

  useEffect(() => {
    if (!hasActiveCustomerRides) return undefined;
    let disposed = false;
    const refreshCustomerRides = async () => {
      try {
        const result = await apiRequest<{ data: Ride[] }>("/api/v1/rides/mine", activeSession.accessToken, undefined, refreshAccessToken);
        if (!disposed) setRides(result.data ?? []);
      } catch {
        // Continue showing the last server-confirmed state when temporarily offline.
      }
    };
    const timer = setInterval(() => void refreshCustomerRides(), 8_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [hasActiveCustomerRides, activeSession.accessToken, refreshAccessToken]);

  useEffect(() => {
    if (!isCustomer) return undefined;
    const activeParcels = sentParcels.filter((parcel) =>
      ACTIVE_TRACKING_STATUSES.includes(parcel.status) && Boolean(parcel.rider)
    );
    let disposed = false;

    const refreshTracking = async () => {
      const results = await Promise.all(activeParcels.map(async (parcel) => {
        try {
          const response = await apiRequest<{ data: ParcelTracking }>(
            `/api/v1/parcels/${parcel.id}/tracking`,
            activeSession.accessToken,
            undefined,
            refreshAccessToken
          );
          return [parcel.id, response.data] as const;
        } catch {
          return null;
        }
      }));
      if (disposed) return;
      setParcelTrackings((current) => {
        const next: Record<string, ParcelTracking> = {};
        for (const result of results) {
          if (result) next[result[0]] = result[1];
        }
        return next;
      });
    };

    if (activeParcels.length) {
      void refreshTracking();
      const timer = setInterval(() => void refreshTracking(), 10_000);
      return () => {
        disposed = true;
        clearInterval(timer);
      };
    }
    setParcelTrackings({});
    return () => { disposed = true; };
  }, [isCustomer, sentParcels, activeSession.accessToken, refreshAccessToken]);

  const detectPickupLocation = useCallback(async (allowReplace = false) => {
    setLocationStatus("locating");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        setLocationStatus("denied");
        return;
      }
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
        mayShowUserSettingsDialog: true
      });
      const { latitude, longitude } = position.coords;
      const reverse = await Location.reverseGeocodeAsync({ latitude, longitude });
      const place = reverse[0];
      const description = [
        place?.name,
        place?.street,
        place?.district,
        place?.city,
        place?.region
      ].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(", ")
        || "Current device location";
      const detected: RideLocation = { latitude, longitude, description };
      setDeviceLocation(detected);
      setMapRegion({
        latitude,
        longitude,
        latitudeDelta: 0.075,
        longitudeDelta: 0.075
      });
      if (allowReplace || !pickup.trim()) {
        setPickup(description);
        setSelectedPickupLocation(detected);
        setSelectedPickupSearchQuery("");
        setQuote(null);
        setLocations(null);
      }
      setLocationStatus("ready");
    } catch {
      setLocationStatus("unavailable");
    }
  }, [pickup]); 

  useEffect(() => {
    if (isCustomer && !locationDetectionStarted.current) {
      locationDetectionStarted.current = true;
      void detectPickupLocation(false);
    }
  }, [isCustomer]);

  function animateRiderMapTo(point: RideLocation) {
    setMapRegion({ latitude: point.latitude, longitude: point.longitude, latitudeDelta: 0.045, longitudeDelta: 0.045 });
    if (!riderMapReady || !riderMapRef.current) {
      pendingRiderMapCenter.current = point;
      return;
    }
    riderMapRef.current.animateToRegion({
      latitude: point.latitude,
      longitude: point.longitude,
      latitudeDelta: 0.045,
      longitudeDelta: 0.045
    }, 650);
  }

  async function centerRiderMap() {
    if (riderMapCentering.current) return;
    riderMapCentering.current = true;
    setRiderMapCenteringUi(true);
    setError("");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") throw new Error("Allow location access while using NAVIGO to center the rider map.");
      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        mayShowUserSettingsDialog: true
      });
      const point: RideLocation = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        description: "Your current location"
      };
      setRiderDeviceLocation(point);
      animateRiderMapTo(point);
    } catch (locationError) {
      setError(locationError instanceof Error ? locationError.message : "Unable to find your current location.");
    } finally {
      riderMapCentering.current = false;
      setRiderMapCenteringUi(false);
    }
  }

  async function openRiderMapDirections() {
    if (!riderMapNavigationTarget) {
      setError("Your accepted job's location coordinates are not available yet.");
      return;
    }
    const { latitude, longitude } = riderMapNavigationTarget;
    const origin = riderDeviceLocation;
    const url = origin
      ? `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${origin.latitude}%2C${origin.longitude}%3B${latitude}%2C${longitude}`
      : `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=16/${latitude}/${longitude}`;
    try {
      await Linking.openURL(url);
    } catch {
      setError("Unable to open directions on this device.");
    }
  }

  async function toggleRiderAvailability() {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      if (riderOnline) {
        await apiRequest("/api/v1/rides/availability/offline", activeSession.accessToken, { method: "POST" }, refreshAccessToken);
        setRiderOnline(false);
        setAvailableRides([]);
        setMainTab("home");
        setMessage("You are offline. NAVIGO will no longer send nearby ride requests to this device.");
      } else {
        const permission = await Location.requestForegroundPermissionsAsync();
        if (permission.status !== "granted") throw new Error("Allow location access while using NAVIGO to receive nearby ride requests.");
        const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest, mayShowUserSettingsDialog: true });
        const accuracyMeters = position.coords.accuracy;
        if (accuracyMeters === null || accuracyMeters > 500) throw new Error("Your GPS accuracy is too low. Move to an open area and try going online again.");
        await apiRequest("/api/v1/rides/availability/online", activeSession.accessToken, {
          method: "POST",
          body: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyMeters })
        }, refreshAccessToken);
        const riderLocation = { latitude: position.coords.latitude, longitude: position.coords.longitude, description: "Your current location" };
        setRiderDeviceLocation(riderLocation);
        setRiderOnline(true);
        setRiderRequestTab("rides");
        setMainTab("requests");
        animateRiderMapTo(riderLocation);
        setMessage("You are online. New ride requests will appear here automatically.");
      }
    } catch (availabilityError) {
      setError(availabilityError instanceof Error ? availabilityError.message : "Unable to update your rider availability.");
    } finally {
      setWorking(false);
    }
  }

  async function getFareEstimate(overrides?: {
    pickup?: RideLocation | null;
    destination?: RideLocation | null;
    pickupText?: string;
    destinationText?: string;
  }) {
    setWorking(true);
    setError("");
    setMessage("");
    setQuote(null);
    setLocations(null);
    try {
      const pickupPoint = overrides && Object.prototype.hasOwnProperty.call(overrides, "pickup")
        ? overrides.pickup
        : selectedPickupLocation;
      const destinationPoint = overrides && Object.prototype.hasOwnProperty.call(overrides, "destination")
        ? overrides.destination
        : selectedDestinationLocation;
      const pickupText = overrides?.pickupText ?? (selectedPickupSearchQuery || pickup);
      const destinationText = overrides?.destinationText ?? (selectedDestinationSearchQuery || destination);
      const [pickupLocation, destinationLocation] = await Promise.all([
        pickupPoint ?? geocodeAruaAddress(pickupText, activeSession.accessToken, refreshAccessToken),
        destinationPoint ?? geocodeAruaAddress(destinationText, activeSession.accessToken, refreshAccessToken)
      ]);
      const result = await apiRequest<{ data: Quote }>("/api/v1/rides/fare-quote", activeSession.accessToken, {
        method: "POST",
        body: JSON.stringify({ pickup: pickupLocation, destination: destinationLocation })
      }, refreshAccessToken);
      if (!Array.isArray(result.data?.routeCoordinates) || result.data.routeCoordinates.length < 2) {
        throw new Error("NAVIGO received the fare but not a complete road route. Please try selecting the suggested pickup and destination again.");
      }
      setLocations({ pickup: pickupLocation, destination: destinationLocation });
      setQuote(result.data);
      setMapRegion(routeMapRegion(result.data.routeCoordinates, mapSheetRouteReviewHeight));
      setActiveLocationField(null);
      setMapSheetExpanded(false);
    } catch (quoteError) {
      setActiveLocationField(null);
      setMapSheetExpanded(true);
      setError(quoteError instanceof Error ? quoteError.message : "Unable to calculate the fare.");
    } finally {
      setWorking(false);
    }
  }

  function previewRideRoute() {
    if (!pickup.trim() || !destination.trim()) {
      setError("Enter both a pickup location and a destination before viewing the route.");
      setMapSheetExpanded(true);
      return;
    }
    setError("");
    setMessage("");
    setActiveLocationField(null);
    setMapSheetExpanded(true);
    Keyboard.dismiss();
    void getFareEstimate();
  }

  async function requestRide() {
    if (!quote || !locations) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await apiRequest<{ data: Ride }>("/api/v1/rides", activeSession.accessToken, {
        method: "POST",
        body: JSON.stringify({ ...locations, paymentMethod, quoteToken: quote.quoteToken })
      }, refreshAccessToken);
      setMessage("Your request is in. NAVIGO is finding a nearby rider. Follow the progress under My rides.");
      setQuote(null);
      setLocations(null);
      setPickup("");
      setDestination("");
      setMainTab("activity");
      setCustomerActivityTab("rides");
      await loadDashboard();
    } catch (requestError) {
      const errorMessage = requestError instanceof Error
        ? requestError.message
        : "Unable to create the ride request.";
      if (/fare quote has expired|pickup or destination has changed/i.test(errorMessage)) {
        setQuote(null);
        setLocations(null);
        setMapSheetExpanded(true);
      }
      setError(errorMessage);
    } finally {
      setWorking(false);
    }
  }

  async function getParcelFareEstimate(overrides?: {
    pickup?: RideLocation | null;
    destination?: RideLocation | null;
    pickupText?: string;
    destinationText?: string;
  }) {
    setWorking(true);
    setError("");
    setMessage("");
    setParcelQuote(null);
    setParcelLocations(null);
    setCreatedParcel(null);
    try {
      const pickupPoint = overrides && Object.prototype.hasOwnProperty.call(overrides, "pickup")
        ? overrides.pickup
        : selectedPickupLocation;
      const destinationPoint = overrides && Object.prototype.hasOwnProperty.call(overrides, "destination")
        ? overrides.destination
        : selectedDestinationLocation;
      const pickupText = overrides?.pickupText ?? (selectedPickupSearchQuery || pickup);
      const destinationText = overrides?.destinationText ?? (selectedDestinationSearchQuery || destination);
      const [pickupLocation, destinationLocation] = await Promise.all([
        pickupPoint ?? geocodeAruaAddress(pickupText, activeSession.accessToken, refreshAccessToken),
        destinationPoint ?? geocodeAruaAddress(destinationText, activeSession.accessToken, refreshAccessToken)
      ]);
      const result = await apiRequest<{ data: ParcelQuote }>("/api/v1/parcels/fare-quote", activeSession.accessToken, {
        method: "POST",
        body: JSON.stringify({ pickup: pickupLocation, destination: destinationLocation, sizeCategory: parcelSize })
      }, refreshAccessToken);
      setParcelLocations({ pickup: pickupLocation, destination: destinationLocation });
      setParcelQuote(result.data);
      setMapRegion(routeMapRegion(result.data.routeCoordinates));
    } catch (quoteError) {
      setError(quoteError instanceof Error ? quoteError.message : "Unable to calculate the item delivery fee.");
    } finally {
      setWorking(false);
    }
  }

  async function requestParcel() {
    if (!parcelQuote || !parcelLocations) return;
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const result = await apiRequest<{ data: ParcelRequest }>("/api/v1/parcels", activeSession.accessToken, {
        method: "POST",
        body: JSON.stringify({
          ...parcelLocations,
          sizeCategory: parcelSize,
          recipientName,
          recipientPhone,
          parcelDescription: itemDescription,
          paymentMethod
        })
      }, refreshAccessToken);
      setCreatedParcel(result.data);
      setMessage("Your item delivery request has been sent. Share the recipient delivery code with the person receiving the item.");
      setParcelQuote(null);
      setParcelLocations(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to send this item.");
    } finally {
      setWorking(false);
    }
  }

  async function performParcelAction(parcelId: string, action: "accept" | "cancel" | "ARRIVED_AT_PICKUP" | "IN_TRANSIT" | "ARRIVED_AT_DESTINATION" | "verify-pickup" | "verify-delivery") {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      if (action === "cancel") {
        await apiRequest(`/api/v1/parcels/${parcelId}/cancel`, activeSession.accessToken, { method: "POST" }, refreshAccessToken);
      } else if (action === "accept") {
        await apiRequest(`/api/v1/parcels/${parcelId}/accept`, activeSession.accessToken, { method: "POST" }, refreshAccessToken);
      } else if (action === "verify-pickup" || action === "verify-delivery") {
        const code = (parcelCodeInputs[parcelId] ?? "").trim();
        if (!/^\d{6}$/.test(code)) throw new Error("Enter the six-digit verification code.");
        await apiRequest(`/api/v1/parcels/${parcelId}/${action}`, activeSession.accessToken, {
          method: "POST",
          body: JSON.stringify({ code })
        }, refreshAccessToken);
        setParcelCodeInputs((current) => ({ ...current, [parcelId]: "" }));
      } else {
        await apiRequest(`/api/v1/parcels/${parcelId}/status`, activeSession.accessToken, {
          method: "PATCH",
          body: JSON.stringify({ status: action })
        }, refreshAccessToken);
      }
      setMessage(action === "accept" ? "Item delivery accepted." : action.startsWith("verify") ? "Verification successful. Delivery progress updated." : "Item delivery progress updated.");
      await loadDashboard();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update this item delivery.");
    } finally {
      setWorking(false);
    }
  }

  async function recordManualPayment(requestType: "ride" | "parcel", requestId: string) {
    const referenceMap = requestType === "ride" ? ridePaymentReferences : parcelPaymentReferences;
    const transactionReference = (referenceMap[requestId] ?? "").trim();
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const endpoint = requestType === "ride" ? "rides" : "parcels";
      await apiRequest(`/api/v1/${endpoint}/${requestId}/payment/record`, activeSession.accessToken, {
        method: "POST",
        body: JSON.stringify(transactionReference ? { transactionReference } : {})
      }, refreshAccessToken);
      if (requestType === "ride") {
        setRidePaymentReferences((current) => ({ ...current, [requestId]: "" }));
      } else {
        setParcelPaymentReferences((current) => ({ ...current, [requestId]: "" }));
      }
      setMessage("Payment marked as received. This is a manual rider confirmation; NAVIGO does not automatically verify Mobile Money transfers.");
      await loadDashboard();
    } catch (paymentError) {
      setError(paymentError instanceof Error ? paymentError.message : "Unable to record this payment.");
    } finally {
      setWorking(false);
    }
  }

  async function startParcelLocationSharing(parcelId: string) {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted") {
        throw new Error("Allow location access to share your live position with the item sender.");
      }

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Highest,
        mayShowUserSettingsDialog: true
      });
      const accuracyMeters = position.coords.accuracy;
      if (accuracyMeters === null || accuracyMeters > 500) {
        throw new Error("Your GPS accuracy is too low. Move to an open area and try again.");
      }

      await apiRequest(`/api/v1/parcels/${parcelId}/tracking/start`, activeSession.accessToken, {
        method: "POST"
      }, refreshAccessToken);
      await apiRequest(`/api/v1/parcels/${parcelId}/tracking/location`, activeSession.accessToken, {
        method: "POST",
        body: JSON.stringify({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters
        })
      }, refreshAccessToken);

      setTrackingParcelIds((current) => current.includes(parcelId) ? current : [...current, parcelId]);
      setMessage("Live location sharing is on. The sender can see your recent location while the app is open.");
    } catch (trackingError) {
      try {
        await apiRequest(`/api/v1/parcels/${parcelId}/tracking/stop`, activeSession.accessToken, {
          method: "POST"
        }, refreshAccessToken);
      } catch {
        // The server's two-minute freshness limit prevents an old point from appearing as live.
      }
      setError(trackingError instanceof Error ? trackingError.message : "Unable to start live location sharing.");
    } finally {
      setWorking(false);
    }
  }

  async function stopParcelLocationSharing(parcelId: string) {
    setWorking(true);
    setError("");
    try {
      await apiRequest(`/api/v1/parcels/${parcelId}/tracking/stop`, activeSession.accessToken, {
        method: "POST"
      }, refreshAccessToken);
      setTrackingParcelIds((current) => current.filter((id) => id !== parcelId));
      setMessage("Live location sharing has stopped.");
    } catch (trackingError) {
      setError(trackingError instanceof Error ? trackingError.message : "Unable to stop location sharing.");
    } finally {
      setWorking(false);
    }
  }

  useEffect(() => {
    if (!isApprovedRider || !riderOnline || AppState.currentState !== "active") return undefined;
    let disposed = false;
    let subscription: Location.LocationSubscription | null = null;
    const startAvailabilityWatcher = async () => {
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.status !== "granted") return;
      try {
        const watcher = await Location.watchPositionAsync({ accuracy: Location.Accuracy.Highest, timeInterval: 10_000, distanceInterval: 12 }, (position) => {
          const accuracyMeters = position.coords.accuracy;
          if (accuracyMeters === null || accuracyMeters > 500) return;
          setRiderDeviceLocation({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            description: "Your latest GPS location"
          });
          void apiRequest("/api/v1/rides/availability/location", activeSession.accessToken, {
            method: "POST",
            body: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracyMeters })
          }, refreshAccessToken).catch(() => undefined);
        });
        if (disposed) watcher.remove(); else subscription = watcher;
      } catch {
        // Stale server-side location will remove this rider from matching if GPS stops.
      }
    };
    void startAvailabilityWatcher();
    return () => { disposed = true; subscription?.remove(); };
  }, [isApprovedRider, riderOnline, activeSession.accessToken, refreshAccessToken]);

  useEffect(() => {
    if (!isApprovedRider || !riderOnline) return undefined;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        setRiderOnline(false);
        setAvailableRides([]);
        void apiRequest("/api/v1/rides/availability/offline", activeSession.accessToken, { method: "POST" }, refreshAccessToken).catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [isApprovedRider, riderOnline, activeSession.accessToken, refreshAccessToken]);

  useEffect(() => {
    if (!isApprovedRider || !trackingParcelIds.length || AppState.currentState !== "active") {
      return undefined;
    }

    let disposed = false;
    const subscriptions: Location.LocationSubscription[] = [];

    const startWatchers = async () => {
      const permission = await Location.getForegroundPermissionsAsync();
      if (permission.status !== "granted") return;

      for (const parcelId of trackingParcelIds) {
        try {
          const subscription = await Location.watchPositionAsync({
            accuracy: Location.Accuracy.Highest,
            timeInterval: 10_000,
            distanceInterval: 12
          }, (position) => {
            const accuracyMeters = position.coords.accuracy;
            if (accuracyMeters === null || accuracyMeters > 500) return;
            void apiRequest(`/api/v1/parcels/${parcelId}/tracking/location`, activeSession.accessToken, {
              method: "POST",
              body: JSON.stringify({
                latitude: position.coords.latitude,
                longitude: position.coords.longitude,
                accuracyMeters
              })
            }, refreshAccessToken).catch(() => undefined);
          });

          if (disposed) subscription.remove();
          else subscriptions.push(subscription);
        } catch {
          // A failed watcher does not invent a position; the sender sees the last fresh point only.
        }
      }
    };

    void startWatchers();
    return () => {
      disposed = true;
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, [isApprovedRider, trackingParcelIds, activeSession.accessToken, refreshAccessToken]);

  useEffect(() => {
    if (!isApprovedRider || !trackingParcelIds.length) return undefined;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        const ids = [...trackingParcelIds];
        setTrackingParcelIds([]);
        ids.forEach((parcelId) => {
          void apiRequest(`/api/v1/parcels/${parcelId}/tracking/stop`, activeSession.accessToken, {
            method: "POST"
          }, refreshAccessToken).catch(() => undefined);
        });
      }
    });
    return () => subscription.remove();
  }, [isApprovedRider, trackingParcelIds, activeSession.accessToken, refreshAccessToken]);

  useEffect(() => {
    const activeAssignedIds = new Set(
      assignedParcels
        .filter((parcel) => ACTIVE_TRACKING_STATUSES.includes(parcel.status))
        .map((parcel) => parcel.id)
    );
    const expiredIds = trackingParcelIds.filter((parcelId) => !activeAssignedIds.has(parcelId));
    if (!expiredIds.length) return;
    setTrackingParcelIds((current) => current.filter((parcelId) => activeAssignedIds.has(parcelId)));
    expiredIds.forEach((parcelId) => {
      void apiRequest(`/api/v1/parcels/${parcelId}/tracking/stop`, activeSession.accessToken, {
        method: "POST"
      }, refreshAccessToken).catch(() => undefined);
    });
  }, [assignedParcels, trackingParcelIds, activeSession.accessToken, refreshAccessToken]);

  async function reviewAdminRider(
    riderId: string,
    approvalStatus: "APPROVED" | "REJECTED" | "SUSPENDED"
  ) {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await apiRequest(`/api/v1/admin/riders/${riderId}/approval`, activeSession.accessToken, {
        method: "PATCH",
        body: JSON.stringify({
          approvalStatus,
          ...(adminReviewReason.trim() ? { rejectionReason: adminReviewReason.trim() } : {})
        })
      }, refreshAccessToken);
      setAdminReviewReason("");
      setMessage(approvalStatus === "APPROVED" ? "Rider approved. They can now receive NAVIGO requests." : `Rider status changed to ${approvalStatus.toLowerCase()}.`);
      await loadDashboard();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Unable to update the rider application.");
    } finally {
      setWorking(false);
    }
  }

  function resetFareRuleEditor() {
    setEditingFareRuleId(null);
    setEditingFareRuleActive(true);
    setFareRequestType("PARCEL");
    setFareSize("SMALL");
    setFareMinDistance("");
    setFareMaxDistance("");
    setFareAmount("");
  }

  function beginFareRuleEdit(rule: AdminFareRule) {
    setEditingFareRuleId(rule.id);
    setEditingFareRuleActive(rule.isActive);
    setFareRequestType(rule.requestType);
    setFareSize(rule.parcelSize ?? "SMALL");
    setFareMinDistance(String(rule.minDistanceKm));
    setFareMaxDistance(rule.maxDistanceKm === null ? "" : String(rule.maxDistanceKm));
    setFareAmount(String(rule.fareUgx));
    setAdminTab("fares");
    setMessage("");
    setError("");
  }

  async function saveAdminFareRule() {
    const minDistanceKm = Number(fareMinDistance);
    const maxDistanceKm = fareMaxDistance.trim() ? Number(fareMaxDistance) : null;
    const fareUgx = Number(fareAmount);
    if (!fareMinDistance.trim() || !Number.isFinite(minDistanceKm) || minDistanceKm < 0) {
      setError("Enter a valid minimum distance in kilometres.");
      return;
    }
    if (maxDistanceKm !== null && (!Number.isFinite(maxDistanceKm) || maxDistanceKm <= minDistanceKm)) {
      setError("The maximum distance must be greater than the minimum distance, or left blank.");
      return;
    }
    if (!Number.isInteger(fareUgx) || fareUgx < 500) {
      setError("Enter a valid fare in whole Uganda shillings (at least UGX 500).");
      return;
    }

    setWorking(true);
    setError("");
    setMessage("");
    const payload = {
      requestType: fareRequestType,
      parcelSize: fareRequestType === "PARCEL" ? fareSize : null,
      minDistanceKm,
      maxDistanceKm,
      fareUgx,
      isActive: editingFareRuleId ? editingFareRuleActive : true
    };
    try {
      await apiRequest(
        editingFareRuleId
          ? `/api/v1/admin/fare-rules/${editingFareRuleId}`
          : "/api/v1/admin/fare-rules",
        activeSession.accessToken,
        { method: editingFareRuleId ? "PATCH" : "POST", body: JSON.stringify(payload) },
        refreshAccessToken
      );
      setMessage(editingFareRuleId ? "Fare rule updated." : "Fare rule created.");
      resetFareRuleEditor();
      await loadDashboard();
    } catch (fareError) {
      setError(fareError instanceof Error ? fareError.message : "Unable to save this fare rule.");
    } finally {
      setWorking(false);
    }
  }

  async function toggleAdminFareRule(rule: AdminFareRule) {
    setWorking(true);
    setError("");
    setMessage("");
    try {
      await apiRequest(`/api/v1/admin/fare-rules/${rule.id}`, activeSession.accessToken, {
        method: "PATCH",
        body: JSON.stringify({
          requestType: rule.requestType,
          parcelSize: rule.parcelSize,
          minDistanceKm: Number(rule.minDistanceKm),
          maxDistanceKm: rule.maxDistanceKm === null ? null : Number(rule.maxDistanceKm),
          fareUgx: rule.fareUgx,
          isActive: !rule.isActive
        })
      }, refreshAccessToken);
      setMessage(rule.isActive ? "Fare rule deactivated." : "Fare rule activated.");
      await loadDashboard();
    } catch (fareError) {
      setError(fareError instanceof Error ? fareError.message : "Unable to change fare rule status.");
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
      if (isApprovedRider && action !== "cancel") {
        setRiderJobTab("rides");
        setMainTab("home");
      }
      setMessage(action === "accept"
        ? "Ride accepted. Follow the map and complete each ride step from this screen."
        : "Ride status updated. Your next ride step is ready below the map.");
      await loadDashboard();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Unable to update this ride.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style={appearance === "DARK" ? "light" : "dark"} />
      <ScrollView
        style={styles.mainScroll}
        scrollEnabled={!((isCustomer && mainTab === "home") || mapGestureActive)}
        contentContainerStyle={[styles.page, isCustomer && mainTab === "home" ? styles.mapHomePage : null]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {!(isCustomer && mainTab === "home") ? (
        <View style={styles.topBar}>
          <View>
            <Text style={styles.brandSmall}>NAVIGO</Text>
            <Text style={styles.greeting}>Hello, {session.user.fullName.split(" ")[0]}</Text>
            <Text style={styles.muted}>{isCustomer ? "Your ride starts here" : "Your rider workspace"}</Text>
          </View>
{activeSession.user.role === "ADMIN" ? (
            <TouchableOpacity style={styles.signOut} onPress={onSignOut} disabled={signingOut}>
              {signingOut ? <ActivityIndicator color="#174A72" /> : <Text style={styles.signOutText}>Sign out</Text>}
            </TouchableOpacity>
          ) : null}
        </View>
        ) : null}

        {isCustomer ? (
          <>
            {mainTab === "home" ? (
              <>
            <View style={styles.customerMapFrame}>
              <SafeMapView
                style={styles.customerMap}
                region={mapRegion}
                routeCoordinates={quote?.routeCoordinates ?? parcelQuote?.routeCoordinates}
                markers={[
                  { coordinate: locations?.pickup ?? parcelLocations?.pickup ?? selectedPickupLocation ?? deviceLocation, title: "Pickup", pinColor: "#21865B" },
                  { coordinate: locations?.destination ?? parcelLocations?.destination ?? selectedDestinationLocation, title: "Destination", pinColor: "#C54848" }
                ]}
                onRegionChangeComplete={setMapRegion}
                customMapStyle={LIGHT_MAP_STYLE}
                showsCompass={false}
                showsScale={false}
                showsUserLocation={locationStatus === "ready"}
                showsMyLocationButton={false}
                toolbarEnabled={false}
              >
                {quote && locations ? (
                  <Polyline coordinates={quote.routeCoordinates} strokeColor="#1F76A8" strokeWidth={5} />
                ) : parcelQuote && parcelLocations ? (
                  <Polyline coordinates={parcelQuote.routeCoordinates} strokeColor="#1F76A8" strokeWidth={5} />
                ) : null}
                {(locations?.pickup ?? parcelLocations?.pickup ?? selectedPickupLocation ?? deviceLocation) ? (
                  <Marker
                    coordinate={locations?.pickup ?? parcelLocations?.pickup ?? selectedPickupLocation ?? deviceLocation!}
                    title={locations?.pickup || parcelLocations?.pickup || selectedPickupLocation ? "Pickup point" : "Your current location"}
                    description={(locations?.pickup ?? parcelLocations?.pickup ?? selectedPickupLocation ?? deviceLocation)?.description}
                    pinColor="#21865B"
                  />
                ) : null}
                {(locations?.destination ?? parcelLocations?.destination ?? selectedDestinationLocation) ? (
                  <Marker
                    coordinate={locations?.destination ?? parcelLocations?.destination ?? selectedDestinationLocation!}
                    title="Destination point"
                    description={(locations?.destination ?? parcelLocations?.destination ?? selectedDestinationLocation)?.description}
                    pinColor="#C54848"
                  />
                ) : null}
              </SafeMapView>
              <View style={styles.mapBrandPill}>
                <Text style={styles.mapBrandText}>NAVIGO  •  ARUA</Text>
              </View>
              <TouchableOpacity style={styles.customerMapRecenterButton} onPress={() => void detectPickupLocation(false)}>
                <Text style={styles.mapRecenterText}>◎</Text>
              </TouchableOpacity>
              {locationStatus !== "ready" ? (
                <TouchableOpacity style={[styles.locationRetryPill, styles.mapLocationRetryPill]} onPress={() => void detectPickupLocation(true)}>
                  <Text style={styles.locationRetryText}>{locationStatus === "locating" ? "Locating..." : "Use my location"}</Text>
                </TouchableOpacity>
              ) : null}
            <Animated.View style={[styles.customerMapSheet, { height: mapSheetHeight }]}>
              {activeLocationField === null ? (
              <View style={styles.mapSheetDragArea} {...mapSheetPanResponder.panHandlers}>
                <View style={styles.mapSheetGrip} />
                <TouchableOpacity style={styles.mapSheetWhereTo} onPress={() => setMapSheetExpanded((expanded) => !expanded)}>
                  <Text style={styles.mapSheetWhereToText}>{destination.trim() || "Where to?"}</Text>
                  <Text style={styles.mapSheetPickupSummary} numberOfLines={1}>
                    Pickup: {pickup || (locationStatus === "locating" ? "Finding your location..." : "Choose your pickup point")}
                  </Text>
                </TouchableOpacity>
              </View>
              ) : (
                <View style={styles.locationSearchHeader}>
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Back to booking map" style={styles.locationSearchBackButton} onPress={() => { setActiveLocationField(null); Keyboard.dismiss(); }}>
                    <Text style={styles.locationSearchBackText}>‹</Text>
                  </TouchableOpacity>
                  <Text style={styles.locationSearchTitle}>Pickup & Drop Off</Text>
                </View>
              )}
              <ScrollView style={styles.mapSheetScroll} contentContainerStyle={styles.mapSheetContent} keyboardShouldPersistTaps="handled" nestedScrollEnabled showsVerticalScrollIndicator={false}>
            {activeLocationField === null ? <>
            <View style={styles.serviceHeading}>
              <Text style={styles.serviceHeadingTitle}>Where can we help you go?</Text>
              <Text style={styles.serviceHeadingSubtitle}>Choose a service</Text>
            </View>
            <View style={styles.serviceChoices}>
              <TouchableOpacity style={[styles.serviceTile, tab !== "parcel" ? styles.serviceTileActive : null]} onPress={() => { setMainTab("home"); setTab("book"); setError(""); setMessage(""); }}>
                <Text style={styles.serviceEmoji}>🏍️</Text>
                <Text style={styles.serviceTitle}>Ride</Text>
                <Text style={styles.serviceDescription}>Travel around Arua</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.serviceTile, tab === "parcel" ? styles.serviceTileActive : null]} onPress={() => { setMainTab("home"); setTab("parcel"); setError(""); setMessage(""); setCreatedParcel(null); }}>
                <Text style={styles.serviceEmoji}>📦</Text>
                <Text style={styles.serviceTitle}>Send an Item</Text>
                <Text style={styles.serviceDescription}>Pickup and delivery</Text>
              </TouchableOpacity>
            </View>
            </> : null}


            {tab === "parcel" ? (
              <View style={styles.card}>
                {activeLocationField === null ? <Text style={styles.cardTitle}>Send an item</Text> : null}
                {activeLocationField === null ? <Text style={styles.bodyText}>We'll collect your item and deliver it to the person you choose.</Text> : null}
                {createdParcel ? (
                  <View style={styles.codePanel}>
                    <Text style={styles.quoteLabel}>REQUEST CREATED</Text>
                    <Text style={styles.codeHeading}>Give these codes to the right people</Text>
                    <Text style={styles.label}>Pickup code — share with the sender at collection</Text>
                    <Text selectable style={styles.codeValue}>{createdParcel.pickupCode}</Text>
                    <Text style={styles.label}>Delivery code — share privately with the recipient</Text>
                    <Text selectable style={styles.codeValue}>{createdParcel.deliveryCode}</Text>
                    <Text style={styles.bodyText}>Keep the delivery code private. The rider must enter it when the item reaches its destination.</Text>
                  </View>
                ) : (
                  <>
                    <Text style={styles.label}>Pickup location</Text>
                    <TextInput ref={pickupInputRef} style={styles.addressInput} value={pickup} onFocus={() => focusLocationField("pickup")} onChangeText={(value) => { setPickup(value); setSelectedPickupLocation(null); setSelectedPickupSearchQuery(""); setParcelQuote(null); setParcelLocations(null); }} placeholder="Where should we collect the item?" placeholderTextColor="#98A2B3" />
                    {activeLocationField === "pickup" ? <TouchableOpacity style={styles.locationSearchLocationAction} onPress={() => void detectPickupLocation(true)}><Text style={styles.locationSearchLocationActionText}>◎  Use current location</Text></TouchableOpacity> : null}
                    <LocationSuggestions visible={activeLocationField === "pickup"} query={pickup} onSelect={(suggestion) => selectLocationSuggestion("pickup", suggestion)} />
                    <Text style={styles.label}>Delivery location</Text>
                    <TextInput ref={destinationInputRef} style={styles.addressInput} value={destination} onFocus={() => focusLocationField("destination")} onChangeText={(value) => { setDestination(value); setSelectedDestinationLocation(null); setSelectedDestinationSearchQuery(""); setParcelQuote(null); setParcelLocations(null); }} placeholder="Where should we deliver it?" placeholderTextColor="#98A2B3" returnKeyType="done" onSubmitEditing={() => {
                      if (!pickup.trim() || !destination.trim()) return;
                      setActiveLocationField(null);
                      setMapSheetExpanded(false);
                      Keyboard.dismiss();
                      void getParcelFareEstimate();
                    }} />
                    <LocationSuggestions visible={activeLocationField === "destination"} query={destination} onSelect={(suggestion) => selectLocationSuggestion("destination", suggestion)} />
                    <Text style={styles.label}>What are you sending?</Text>
                    <TextInput style={styles.addressInput} value={itemDescription} onChangeText={(value) => { setItemDescription(value); setParcelQuote(null); }} placeholder="e.g. Documents, clothes, phone" placeholderTextColor="#98A2B3" />
                    <Text style={styles.label}>Item size</Text>
                    <View style={styles.paymentRow}>
                      <ChoiceButton label="Small" selected={parcelSize === "SMALL"} onPress={() => { setParcelSize("SMALL"); setParcelQuote(null); }} />
                      <ChoiceButton label="Medium" selected={parcelSize === "MEDIUM"} onPress={() => { setParcelSize("MEDIUM"); setParcelQuote(null); }} />
                      <ChoiceButton label="Large" selected={parcelSize === "LARGE"} onPress={() => { setParcelSize("LARGE"); setParcelQuote(null); }} />
                    </View>
                    <Text style={styles.label}>Recipient's name</Text>
                    <TextInput style={styles.addressInput} value={recipientName} onChangeText={setRecipientName} placeholder="Person receiving the item" placeholderTextColor="#98A2B3" />
                    <Text style={styles.label}>Recipient's phone number</Text>
                    <TextInput style={styles.addressInput} value={recipientPhone} onChangeText={setRecipientPhone} keyboardType="phone-pad" placeholder="e.g. 07XXXXXXXX" placeholderTextColor="#98A2B3" />
                    <Text style={styles.label}>Payment preference</Text>
                    <View style={styles.paymentRow}>
                      <ChoiceButton label="Cash" selected={paymentMethod === "CASH"} onPress={() => setPaymentMethod("CASH")} />
                      <ChoiceButton label="Mobile Money" selected={paymentMethod === "MOBILE_MONEY"} onPress={() => setPaymentMethod("MOBILE_MONEY")} />
                    </View>
                    {parcelQuote && parcelLocations ? (
                      <>
                        <View style={styles.routeMapFrame}>
                          <SafeMapView style={styles.routeMap} initialRegion={routeMapRegion(parcelQuote.routeCoordinates)} routeCoordinates={parcelQuote.routeCoordinates} markers={[{ coordinate: parcelLocations.pickup, title: "Pickup", pinColor: "#21865B" }, { coordinate: parcelLocations.destination, title: "Delivery", pinColor: "#C54848" }]} scrollEnabled={false} zoomEnabled={false} rotateEnabled={false} pitchEnabled={false} toolbarEnabled={false} showsCompass={false} showsScale={false}>
                            <Polyline coordinates={parcelQuote.routeCoordinates} strokeColor="#1F76A8" strokeWidth={5} />
                            <Marker coordinate={parcelLocations.pickup} title="Pickup" pinColor="#21865B" />
                            <Marker coordinate={parcelLocations.destination} title="Delivery" pinColor="#C54848" />
                          </SafeMapView>
                        </View>
                        <View style={styles.quoteCard}>
                          <Text style={styles.quoteLabel}>ITEM DELIVERY FEE</Text>
                          <Text style={styles.quoteAmount}>{money(parcelQuote.fareAmountUgx)}</Text>
                          <Text style={styles.quoteNote}>{parcelQuote.distanceKm.toFixed(2)} km by motorcycle road route</Text>
                          <Text style={styles.quoteNote}>About {Math.max(1, Math.ceil(parcelQuote.durationSeconds / 60))} minutes estimated travel time</Text>
                        </View>
                      </>
                    ) : null}
                  </>
                )}
                {error ? <Notice tone="error" text={error} /> : null}
                {message ? <Notice tone="success" text={message} /> : null}
                {!createdParcel ? (
                  <PrimaryButton label={parcelQuote ? "Confirm item delivery" : "Calculate delivery fee"} loading={working} onPress={parcelQuote ? requestParcel : getParcelFareEstimate} disabled={working || !pickup.trim() || !destination.trim() || !itemDescription.trim() || !recipientName.trim() || !recipientPhone.trim()} />
                ) : (
                  <PrimaryButton label="Send another item" loading={false} onPress={() => { setCreatedParcel(null); setPickup(""); setDestination(""); setItemDescription(""); setRecipientName(""); setRecipientPhone(""); setSelectedPickupLocation(null); setSelectedDestinationLocation(null); setParcelQuote(null); }} />
                )}
              </View>

            ) : (
              <View style={styles.card}>
                {quote && locations ? (
                  <>
                    <Text style={styles.quoteLabel}>ROUTE READY FOR REVIEW</Text>
                    <Text style={styles.cardTitle}>Your ride details</Text>
                    <View style={styles.routeReviewLocations}>
                      <View style={styles.routeReviewStop}>
                        <View style={styles.pickupDot} />
                        <View style={styles.routeReviewStopCopy}>
                          <Text style={styles.quoteMetricLabel}>PICKUP</Text>
                          <Text style={styles.routeReviewAddress}>{locations.pickup.description || pickup}</Text>
                        </View>
                      </View>
                      <View style={styles.routeReviewStop}>
                        <View style={styles.destinationDot} />
                        <View style={styles.routeReviewStopCopy}>
                          <Text style={styles.quoteMetricLabel}>DESTINATION</Text>
                          <Text style={styles.routeReviewAddress}>{locations.destination.description || destination}</Text>
                        </View>
                      </View>
                    </View>
                    <View style={styles.quoteCard}>
                      <Text style={styles.quoteLabel}>ESTIMATED RIDE FARE</Text>
                      <Text style={styles.quoteAmount}>{money(quote.fareAmountUgx)}</Text>
                      <View style={styles.quoteDivider} />
                      <View style={styles.quoteMetricRow}>
                        <Text style={styles.quoteMetricLabel}>Road distance</Text>
                        <Text style={styles.quoteMetricValue}>{quote.distanceKm.toFixed(2)} km</Text>
                      </View>
                      <View style={styles.quoteMetricRow}>
                        <Text style={styles.quoteMetricLabel}>Estimated travel time</Text>
                        <Text style={styles.quoteMetricValue}>About {Math.max(1, Math.ceil(quote.durationSeconds / 60))} min</Text>
                      </View>
                      <Text style={styles.quoteNote}>The blue line on the map shows the suggested motorcycle road route. This is an estimate; actual travel time can change with road conditions.</Text>
                    </View>
                    <Text style={styles.label}>Choose how to pay</Text>
                    <View style={styles.paymentRow}>
                      <ChoiceButton label="Cash" selected={paymentMethod === "CASH"} onPress={() => setPaymentMethod("CASH")} />
                      <ChoiceButton label="Mobile Money" selected={paymentMethod === "MOBILE_MONEY"} onPress={() => setPaymentMethod("MOBILE_MONEY")} />
                    </View>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={styles.quoteEditButton}
                      onPress={() => {
                        setQuote(null);
                        setLocations(null);
                        setMapSheetExpanded(true);
                        setActiveLocationField("pickup");
                        requestAnimationFrame(() => pickupInputRef.current?.focus());
                      }}
                    >
                      <Text style={styles.quoteEditButtonText}>Change pickup or destination</Text>
                    </TouchableOpacity>
                    <PrimaryButton
                      label={`Confirm ride · ${money(quote.fareAmountUgx)}`}
                      loading={working}
                      onPress={requestRide}
                      disabled={working}
                    />
                  </>
                ) : (
                  <>
                    {activeLocationField === null ? <Text style={styles.cardTitle}>Plan your trip</Text> : null}
                    {activeLocationField === null ? <Text style={styles.bodyText}>Choose where your ride starts and where you are going. NAVIGO will show the motorcycle road route and estimated fare before you confirm.</Text> : null}
                    <Text style={styles.label}>Pickup location</Text>
                    <TextInput
                      ref={pickupInputRef}
                      style={styles.addressInput}
                      value={pickup}
                      onFocus={() => focusLocationField("pickup")}
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
                    {activeLocationField === "pickup" ? <TouchableOpacity style={styles.locationSearchLocationAction} onPress={() => void detectPickupLocation(true)}><Text style={styles.locationSearchLocationActionText}>◎  Use current location</Text></TouchableOpacity> : null}
                    <LocationSuggestions
                      visible={activeLocationField === "pickup"}
                      query={pickup}
                      onSelect={(suggestion) => selectLocationSuggestion("pickup", suggestion)}
                    />
                    <Text style={styles.label}>Destination</Text>
                    <TextInput
                      ref={destinationInputRef}
                      style={styles.addressInput}
                      value={destination}
                      onFocus={() => focusLocationField("destination")}
                      onChangeText={(value) => {
                        setDestination(value);
                        setSelectedDestinationLocation(null);
                        setSelectedDestinationSearchQuery("");
                        setQuote(null);
                        setLocations(null);
                      }}
                      placeholder="e.g. Muni Site or Arua Hill"
                      placeholderTextColor="#98A2B3"
                      returnKeyType="done"
                      onSubmitEditing={previewRideRoute}
                    />
                    <LocationSuggestions
                      visible={activeLocationField === "destination"}
                      query={destination}
                      onSelect={(suggestion) => selectLocationSuggestion("destination", suggestion)}
                    />
                    <PrimaryButton
                      label="Show road route & fare"
                      loading={working}
                      onPress={previewRideRoute}
                      disabled={working || !pickup.trim() || !destination.trim()}
                    />
                    <Text style={styles.quoteNote}>Step 1: choose both places. Step 2: review the route and price. Step 3: confirm only when you are happy with the fare.</Text>
                  </>
                )}
                {error ? <Notice tone="error" text={error} /> : null}
                {message ? <Notice tone="success" text={message} /> : null}
              </View>

            )}
              </ScrollView>
            </Animated.View>
            </View>
              </>
            ) : mainTab === "activity" ? (
              <View style={styles.section}>
                <SectionHeader title="Your activity" onRefresh={loadDashboard} loading={loading} />
                <Text style={styles.activityIntro}>Follow your ride requests and item deliveries, including their latest status and rider details.</Text>
                <View style={styles.activitySummaryRow}>
                  <View style={styles.activitySummaryCard}>
                    <Text style={styles.activitySummaryValue}>{rides.filter((ride) => !["COMPLETED", "CANCELLED", "EXPIRED"].includes(ride.status)).length}</Text>
                    <Text style={styles.activitySummaryLabel}>Active rides</Text>
                  </View>
                  <View style={styles.activitySummaryCard}>
                    <Text style={styles.activitySummaryValue}>{sentParcels.filter((parcel) => !["DELIVERED", "CANCELLED", "EXPIRED"].includes(parcel.status)).length}</Text>
                    <Text style={styles.activitySummaryLabel}>Active deliveries</Text>
                  </View>
                </View>
                <View style={styles.tabRow}>
                  <TabButton label={`Rides · ${rides.length}`} selected={customerActivityTab === "rides"} onPress={() => setCustomerActivityTab("rides")} />
                  <TabButton label={`Item deliveries · ${sentParcels.length}`} selected={customerActivityTab === "parcels"} onPress={() => setCustomerActivityTab("parcels")} />
                </View>
                {customerActivityTab === "parcels" ? (
                  <>
                    {sentParcels.length ? sentParcels.map((parcel) => (
                  <CustomerParcelCard
                    key={parcel.id}
                    parcel={parcel}
                    tracking={parcelTrackings[parcel.id] ?? null}
                    busy={working}
                    onCancel={["PENDING", "ACCEPTED", "ARRIVED_AT_PICKUP"].includes(parcel.status) ? () => performParcelAction(parcel.id, "cancel") : undefined}
                  />
                )) : <EmptyState title="No item deliveries yet" text="Items you send will appear here with their delivery progress." />}
                  </>
                ) : (
                  <>
                    {rides.length ? rides.map((ride) => (
                  <RideCard
                    key={ride.id}
                    ride={ride}
                    customerView
                    busy={working}
                    onCancel={() => performRideAction(ride.id, "cancel")}
                  />
                )) : <EmptyState title="No rides yet" text="Your ride requests and trip history will appear here." />}
                  </>
                )}
                {error ? <Notice tone="error" text={error} /> : null}
                {message ? <Notice tone="success" text={message} /> : null}
              </View>
            ) : (
              <ProfilePanel session={activeSession} onSignOut={onSignOut} signingOut={signingOut} onSaveProfile={saveOwnProfile} onChangePassword={changeOwnPassword} onSwitchWorkspace={switchWorkspace} onApplyRider={applyForRider} refreshAccessToken={refreshAccessToken} appearance={appearance} textSize={textSize} onUpdateUiPreferences={updateUiPreferences} />
            )}
          </>
        ) : activeSession.user.role === "RIDER" ? (
          <>
            {mainTab === "profile" ? (
              <ProfilePanel session={activeSession} onSignOut={onSignOut} signingOut={signingOut} onSaveProfile={saveOwnProfile} onChangePassword={changeOwnPassword} onSwitchWorkspace={switchWorkspace} onApplyRider={applyForRider} refreshAccessToken={refreshAccessToken} appearance={appearance} textSize={textSize} onUpdateUiPreferences={updateUiPreferences} />
            ) : activeSession.user.riderApprovalStatus !== "APPROVED" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Rider application status</Text>
                <View style={styles.statusPill}>
                  <Text style={styles.statusPillText}>{activeSession.user.riderApprovalStatus ?? "NOT SET"}</Text>
                </View>
                <Text style={styles.bodyText}>
                  {activeSession.user.riderApprovalStatus === "PENDING"
                    ? "Thank you for applying. Your details are waiting for administrator review. You can access ride requests after your account is approved."
                    : "Your rider account is not approved for accepting bookings. Please contact NAVIGO support for guidance."}
                </Text>
              </View>
            ) : mainTab === "home" ? (
              <>
                <View style={styles.riderMapFrame}>
                  <SafeMapView
                    ref={riderMapRef}
                    style={styles.customerMap}
                    region={mapRegion}
                    onRegionChangeComplete={setMapRegion}
                    routeCoordinates={riderMapRouteCoordinates}
                    markers={[{ coordinate: riderDeviceLocation, title: "You", pinColor: "#236B9A" }, { coordinate: riderMapPickup, title: "Pickup", pinColor: "#21865B" }, { coordinate: riderMapDestination, title: "Destination", pinColor: "#C54848" }]}
                    onInteractionStart={() => setMapGestureActive(true)}
                    onInteractionEnd={() => setMapGestureActive(false)}
                    onMapReady={() => {
                      setRiderMapReady(true);
                      const pendingCenter = pendingRiderMapCenter.current;
                      if (pendingCenter) {
                        pendingRiderMapCenter.current = null;
                        requestAnimationFrame(() => {
                          riderMapRef.current?.animateToRegion({
                            latitude: pendingCenter.latitude,
                            longitude: pendingCenter.longitude,
                            latitudeDelta: 0.045,
                            longitudeDelta: 0.045
                          }, 650);
                        });
                      }
                    }}
                    customMapStyle={LIGHT_MAP_STYLE}
                    showsCompass={false}
                    showsScale={false}
                    showsUserLocation={riderOnline}
                    showsMyLocationButton={false}
                    toolbarEnabled={false}
                  >
                    {riderMapRouteCoordinates && riderMapRouteCoordinates.length >= 2
                      ? <Polyline coordinates={riderMapRouteCoordinates} strokeColor="#1F76A8" strokeWidth={5} />
                      : null}
                    {!riderOnline && riderDeviceLocation ? <Marker coordinate={riderDeviceLocation} title="Your current location" pinColor="#236B9A" /> : null}
                    {riderMapPickup ? <Marker coordinate={riderMapPickup} title="Accepted job pickup" description="Shown after this job is assigned to you" pinColor="#21865B" /> : null}
                    {riderMapDestination ? <Marker coordinate={riderMapDestination} title="Accepted job destination" description="Shown after this job is assigned to you" pinColor="#C54848" /> : null}
                  </SafeMapView>
                  <View style={styles.mapBrandPill}>
                    <Text style={styles.mapBrandText}>
                      {activeRiderRide
                        ? riderMapStoredRoute ? "NAVIGO • SAVED MOTORCYCLE ROUTE" : "NAVIGO • OLDER RIDE · ROUTE NOT SAVED"
                        : "NAVIGO • RIDER MAP"}
                    </Text>
                  </View>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Center rider map on current location"
                    style={[styles.mapRecenterButton, styles.riderMapRecenterButton]}
                    onPress={() => void centerRiderMap()}
                    disabled={riderMapCenteringUi}
                  >
                    {riderMapCenteringUi
                      ? <ActivityIndicator color="#174A72" size="small" />
                      : <Text style={styles.mapRecenterText}>◎</Text>}
                  </TouchableOpacity>
                  {riderMapNavigationTarget ? (
                    <TouchableOpacity style={styles.riderDirectionsButton} onPress={() => void openRiderMapDirections()}>
                      <Text style={styles.riderDirectionsText}>
                        Directions to {activeRiderRide?.status === "ACCEPTED" || ["ACCEPTED", "ARRIVED_AT_PICKUP"].includes(activeRiderParcel?.status ?? "") ? "pickup" : "destination"}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                  <View style={styles.riderMapStatus}><View style={[styles.riderOnlineDot, riderOnline ? styles.riderOnlineDotActive : null]} /><Text style={styles.riderMapStatusText}>{riderOnline ? "You are online" : "You are offline"}</Text></View>
                </View>
                {activeRiderRide ? (
                  <View style={styles.section}>
                    <View style={styles.sectionHeader}>
                      <Text style={styles.sectionTitle}>Your active ride</Text>
                      <Text style={styles.refreshText}>
                        {activeRiderRide.status === "ACCEPTED" ? "Heading to pickup" : activeRiderRide.status === "ARRIVED_AT_PICKUP" ? "At pickup" : "Journey started"}
                      </Text>
                    </View>
                    <Text style={styles.trackingPrivacyText}>
                      Keep this screen open. Your next ride action is available here, so you do not need to switch to My Jobs.
                    </Text>
                    <RideCard
                      ride={activeRiderRide}
                      busy={working}
                      riderView
                      onAdvance={activeRiderRideNextStatus
                        ? () => performRideAction(activeRiderRide.id, activeRiderRideNextStatus)
                        : undefined}
                    />
                  </View>
                ) : null}
                <View style={styles.trackingControlPanel}>
                  <Text style={styles.sectionTitle}>Rider availability</Text>
                  <Text style={styles.trackingPrivacyText}>
                    {riderOnline
                      ? "You are visible to NAVIGO for nearby ride matching while this app stays open. Your location is used for matching and is not shown to customers before you accept a ride."
                      : "Go online when you are ready to receive ride requests near your current location. Location access is used only while you are online."}
                  </Text>
                  <PrimaryButton label={riderOnline ? "Go offline" : "Go online"} loading={working} onPress={toggleRiderAvailability} disabled={working} />
                </View>
                {!activeRiderRide ? (
                  <>
                    <View style={styles.heroCard}>
                      <Text style={styles.heroEyebrow}>RIDER REQUESTS</Text>
                      <Text style={styles.heroTitle}>{riderOnline ? "Nearby rides." : "Ready for your next ride?"}</Text>
                      <Text style={styles.heroText}>{riderOnline ? "Ride requests are matched to your fresh location and shown nearest first." : "Go online to receive ride requests close to you."}</Text>
                    </View>
                    <View style={styles.quickAccessRow}>
                      <TouchableOpacity style={styles.quickAccessCard} onPress={() => setMainTab("requests")}>
                        <Text style={styles.quickAccessTitle}>Find requests</Text>
                        <Text style={styles.quickAccessText}>View nearby rides and item deliveries</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.quickAccessCard} onPress={() => setMainTab("jobs")}>
                        <Text style={styles.quickAccessTitle}>My jobs</Text>
                        <Text style={styles.quickAccessText}>Manage work you have accepted</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                ) : null}
              </>
            ) : mainTab === "requests" ? (
              <View style={styles.section}>
                <SectionHeader title="Nearby requests" onRefresh={loadDashboard} loading={loading} />
                <View style={styles.tabRow}>
                  <TabButton label="Ride requests" selected={riderRequestTab === "rides"} onPress={() => setRiderRequestTab("rides")} />
                  <TabButton label="Item deliveries" selected={riderRequestTab === "parcels"} onPress={() => setRiderRequestTab("parcels")} />
                </View>
                {riderRequestTab === "rides" ? (
                  <>
                    {availableRides.length ? availableRides.map((ride) => (
                  <RideCard
                    key={ride.id}
                    ride={ride}
                    busy={working}
                    riderView
                    onAccept={() => performRideAction(ride.id, "accept")}
                  />
                )) : <EmptyState
                  title={riderOnline ? "No nearby rides yet" : "You are offline"}
                  text={riderOnline ? "There are no ride requests within your current matching area. NAVIGO will keep checking for nearby requests." : "Go online to see ride requests near your current location."}
                />}
                  </>
                ) : (
                  <>
                    {availableParcels.length ? availableParcels.map((parcel) => (
                  <ParcelRiderCard key={parcel.id} parcel={parcel} busy={working} onAccept={() => performParcelAction(parcel.id, "accept")} />
                )) : <EmptyState title="No available item deliveries" text="New customer item requests will appear here." />}
                  </>
                )}
              </View>
            ) : mainTab === "jobs" ? (
              <View style={styles.section}>
                <SectionHeader title="My jobs" onRefresh={loadDashboard} loading={loading} />
                <View style={styles.tabRow}>
                  <TabButton label="Ride jobs" selected={riderJobTab === "rides"} onPress={() => setRiderJobTab("rides")} />
                  <TabButton label="Item deliveries" selected={riderJobTab === "parcels"} onPress={() => setRiderJobTab("parcels")} />
                </View>
                {riderJobTab === "rides" ? (
                  <>
                    {rides.length ? rides.map((ride) => {
                  const nextStatus = NEXT_RIDER_STATUS[ride.status];
                  return (
                    <RideCard
                      key={ride.id}
                      ride={ride}
                      busy={working}
                      riderView
                      onAdvance={nextStatus ? () => performRideAction(ride.id, nextStatus) : undefined}
                      paymentReference={ridePaymentReferences[ride.id] ?? ""}
                      onPaymentReferenceChange={(value) => setRidePaymentReferences((current) => ({ ...current, [ride.id]: value }))}
                      onRecordPayment={ride.status === "COMPLETED" && ride.payment?.status === "UNPAID" ? () => recordManualPayment("ride", ride.id) : undefined}
                    />
                  );
                }) : <EmptyState title="No assigned rides" text="Rides you accept will appear here." />}
                  </>
                ) : (
                  <>
                    {assignedParcels.length ? assignedParcels.map((parcel) => (
                  <ParcelRiderCard
                    key={parcel.id}
                    parcel={parcel}
                    busy={working}
                    code={parcelCodeInputs[parcel.id] ?? ""}
                    onCodeChange={(value) => setParcelCodeInputs((current) => ({ ...current, [parcel.id]: value.replace(/\D/g, "").slice(0, 6) }))}
                    onAdvance={
                      parcel.status === "ACCEPTED" ? () => performParcelAction(parcel.id, "ARRIVED_AT_PICKUP")
                      : parcel.status === "COLLECTED" ? () => performParcelAction(parcel.id, "IN_TRANSIT")
                      : parcel.status === "IN_TRANSIT" ? () => performParcelAction(parcel.id, "ARRIVED_AT_DESTINATION")
                      : undefined
                    }
                    onVerifyPickup={parcel.status === "ARRIVED_AT_PICKUP" ? () => performParcelAction(parcel.id, "verify-pickup") : undefined}
                    onVerifyDelivery={parcel.status === "ARRIVED_AT_DESTINATION" ? () => performParcelAction(parcel.id, "verify-delivery") : undefined}
                    paymentReference={parcelPaymentReferences[parcel.id] ?? ""}
                    onPaymentReferenceChange={(value) => setParcelPaymentReferences((current) => ({ ...current, [parcel.id]: value }))}
                    onRecordPayment={parcel.status === "DELIVERED" && parcel.payment?.status === "UNPAID" ? () => recordManualPayment("parcel", parcel.id) : undefined}
                    trackingEnabled={trackingParcelIds.includes(parcel.id)}
                    onToggleTracking={ACTIVE_TRACKING_STATUSES.includes(parcel.status)
                      ? () => trackingParcelIds.includes(parcel.id)
                        ? stopParcelLocationSharing(parcel.id)
                        : startParcelLocationSharing(parcel.id)
                      : undefined}
                  />
                )) : <EmptyState title="No assigned item deliveries" text="Item deliveries you accept will appear here." />}
                  </>
                )}
              </View>
            ) : (
              <ProfilePanel session={activeSession} onSignOut={onSignOut} signingOut={signingOut} onSaveProfile={saveOwnProfile} onChangePassword={changeOwnPassword} onSwitchWorkspace={switchWorkspace} onApplyRider={applyForRider} refreshAccessToken={refreshAccessToken} appearance={appearance} textSize={textSize} onUpdateUiPreferences={updateUiPreferences} />
            )}
            {error ? <Notice tone="error" text={error} /> : null}
            {message ? <Notice tone="success" text={message} /> : null}
          </>
        ) : activeSession.user.role === "ADMIN" ? (
          <>
            <View style={styles.heroCard}>
              <Text style={styles.heroEyebrow}>NAVIGO MANAGEMENT</Text>
              <Text style={styles.heroTitle}>Administrator workspace</Text>
              <Text style={styles.heroText}>Review rider applications and manage the distance-based prices used by the service.</Text>
            </View>
            <View style={styles.tabRow}>
              <TouchableOpacity style={[styles.tabButton, adminTab === "riders" ? styles.tabButtonSelected : null]} onPress={() => { setAdminTab("riders"); setMessage(""); setError(""); }}>
                <Text style={[styles.tabText, adminTab === "riders" ? styles.tabTextSelected : null]}>Rider applications</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.tabButton, adminTab === "fares" ? styles.tabButtonSelected : null]} onPress={() => { setAdminTab("fares"); setMessage(""); setError(""); }}>
                <Text style={[styles.tabText, adminTab === "fares" ? styles.tabTextSelected : null]}>Fare rules</Text>
              </TouchableOpacity>
            </View>

            {adminTab === "riders" ? (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Rider applications</Text>
                  <TouchableOpacity onPress={loadDashboard} disabled={loading}>
                    <Text style={styles.refreshText}>{loading ? "Loading..." : "Refresh"}</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.adminFilterRow}>
                  {(["PENDING", "APPROVED", "REJECTED", "SUSPENDED", "ALL"] as const).map((status) => (
                    <TouchableOpacity
                      key={status}
                      style={[styles.adminFilterChip, adminRiderFilter === status ? styles.adminFilterChipSelected : null]}
                      onPress={() => setAdminRiderFilter(status)}
                    >
                      <Text style={[styles.adminFilterText, adminRiderFilter === status ? styles.adminFilterTextSelected : null]}>{status === "ALL" ? "All" : status}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.bodyText}>Check the rider's licence and motorcycle details before approving an application. Rejected or suspended riders cannot accept requests.</Text>
                {adminRiderFilter === "PENDING" || adminRiderFilter === "REJECTED" || adminRiderFilter === "SUSPENDED" ? (
                  <View style={styles.card}>
                    <Text style={styles.label}>Review note (optional)</Text>
                    <TextInput
                      style={styles.addressInput}
                      value={adminReviewReason}
                      onChangeText={setAdminReviewReason}
                      placeholder="Reason for rejection or suspension"
                      placeholderTextColor="#98A2B3"
                      multiline
                    />
                  </View>
                ) : null}
                {adminRiders.length ? adminRiders.map((rider) => (
                  <View key={rider.userId} style={styles.rideCard}>
                    <View style={styles.rideTopRow}>
                      <Text style={styles.rideStatus}>{rider.user.fullName}</Text>
                      <Text style={styles.adminStatusText}>{rider.approvalStatus}</Text>
                    </View>
                    <Text style={styles.rideMeta}>{rider.user.phone}{rider.user.email ? ` • ${rider.user.email}` : ""}</Text>
                    <View style={styles.adminInfoPanel}>
                      <Text style={styles.label}>DRIVING LICENCE</Text>
                      <Text style={styles.routeAddress}>{rider.licenceNumber || "Not provided"}</Text>
                      <Text style={styles.label}>MOTORCYCLE</Text>
                      <Text style={styles.routeAddress}>{rider.motorcycleDescription || "Not provided"}</Text>
                      <Text style={styles.label}>NUMBER PLATE</Text>
                      <Text style={styles.routeAddress}>{rider.motorcyclePlate || "Not provided"}</Text>
                    </View>
                    {rider.rejectionReason ? <Text style={styles.rideMeta}>Previous review note: {rider.rejectionReason}</Text> : null}
                    <View style={styles.adminActionRow}>
                      {rider.approvalStatus !== "APPROVED" ? (
                        <TouchableOpacity style={styles.adminApproveButton} onPress={() => void reviewAdminRider(rider.userId, "APPROVED")} disabled={working}>
                          <Text style={styles.adminApproveText}>Approve</Text>
                        </TouchableOpacity>
                      ) : null}
                      {rider.approvalStatus === "PENDING" || rider.approvalStatus === "APPROVED" ? (
                        <TouchableOpacity style={styles.adminSecondaryButton} onPress={() => void reviewAdminRider(rider.userId, "REJECTED")} disabled={working}>
                          <Text style={styles.adminSecondaryText}>Reject</Text>
                        </TouchableOpacity>
                      ) : null}
                      {rider.approvalStatus === "APPROVED" ? (
                        <TouchableOpacity style={styles.adminSecondaryButton} onPress={() => void reviewAdminRider(rider.userId, "SUSPENDED")} disabled={working}>
                          <Text style={styles.adminSecondaryText}>Suspend</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  </View>
                )) : <EmptyState title="No rider applications here" text={adminRiderFilter === "PENDING" ? "New rider applications will appear here for review." : "There are no riders under this filter."} />}
              </View>
            ) : (
              <View style={styles.section}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionTitle}>Fare configuration</Text>
                  <TouchableOpacity onPress={loadDashboard} disabled={loading}>
                    <Text style={styles.refreshText}>{loading ? "Loading..." : "Refresh"}</Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.bodyText}>Set the price for a road-distance range. Item-delivery prices are separate for Small, Medium and Large items. Avoid overlapping active ranges for the same service and size.</Text>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>{editingFareRuleId ? "Edit fare rule" : "Create fare rule"}</Text>
                  <Text style={styles.label}>Service</Text>
                  <View style={styles.paymentRow}>
                    <ChoiceButton label="Motorcycle ride" selected={fareRequestType === "RIDE"} onPress={() => setFareRequestType("RIDE")} />
                    <ChoiceButton label="Item delivery" selected={fareRequestType === "PARCEL"} onPress={() => setFareRequestType("PARCEL")} />
                  </View>
                  {fareRequestType === "PARCEL" ? (
                    <>
                      <Text style={styles.label}>Item size</Text>
                      <View style={styles.paymentRow}>
                        {(["SMALL", "MEDIUM", "LARGE"] as const).map((size) => (
                          <ChoiceButton key={size} label={size} selected={fareSize === size} onPress={() => setFareSize(size)} />
                        ))}
                      </View>
                    </>
                  ) : null}
                  <Text style={styles.label}>Minimum road distance (km)</Text>
                  <TextInput style={styles.addressInput} value={fareMinDistance} onChangeText={setFareMinDistance} keyboardType="decimal-pad" placeholder="e.g. 0" placeholderTextColor="#98A2B3" />
                  <Text style={styles.label}>Maximum road distance (km)</Text>
                  <TextInput style={styles.addressInput} value={fareMaxDistance} onChangeText={setFareMaxDistance} keyboardType="decimal-pad" placeholder="Leave blank for no upper limit" placeholderTextColor="#98A2B3" />
                  <Text style={styles.label}>Fare amount (UGX)</Text>
                  <TextInput style={styles.addressInput} value={fareAmount} onChangeText={setFareAmount} keyboardType="number-pad" placeholder="Enter the approved fare" placeholderTextColor="#98A2B3" />
                  <Text style={styles.rideMeta}>The fare is saved on the server and applied to new quotes. Existing requests keep their original quoted fare.</Text>
                  <PrimaryButton label={editingFareRuleId ? "Save fare rule" : "Create fare rule"} loading={working} onPress={saveAdminFareRule} disabled={working} />
                  {editingFareRuleId ? (
                    <TouchableOpacity style={styles.cancelButton} onPress={resetFareRuleEditor} disabled={working}>
                      <Text style={styles.cancelText}>Cancel editing</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                <Text style={styles.sectionTitle}>Existing fare rules</Text>
                {adminFareRules.length ? adminFareRules.map((rule) => {
                  const minimum = Number(rule.minDistanceKm);
                  const maximum = rule.maxDistanceKm === null ? null : Number(rule.maxDistanceKm);
                  const range = `${minimum}–${maximum === null ? "no limit" : maximum} km`;
                  const service = rule.requestType === "RIDE" ? "Motorcycle ride" : `Item delivery · ${rule.parcelSize}`;
                  return (
                    <View key={rule.id} style={styles.rideCard}>
                      <View style={styles.rideTopRow}>
                        <Text style={styles.rideStatus}>{service}</Text>
                        <Text style={styles.adminStatusText}>{rule.isActive ? "ACTIVE" : "INACTIVE"}</Text>
                      </View>
                      <Text style={styles.rideMeta}>{range} • {money(rule.fareUgx)}</Text>
                      <View style={styles.adminActionRow}>
                        <TouchableOpacity style={styles.adminSecondaryButton} onPress={() => beginFareRuleEdit(rule)} disabled={working}>
                          <Text style={styles.adminSecondaryText}>Edit</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.adminSecondaryButton} onPress={() => void toggleAdminFareRule(rule)} disabled={working}>
                          <Text style={styles.adminSecondaryText}>{rule.isActive ? "Deactivate" : "Activate"}</Text>
                        </TouchableOpacity>
                      </View>
                    </View>
                  );
                }) : <EmptyState title="No fare rules configured" text="Create a fare rule above. Item delivery quotes will remain unavailable for sizes and distances without an active rule." />}
              </View>
            )}
            {error ? <Notice tone="error" text={error} /> : null}
            {message ? <Notice tone="success" text={message} /> : null}
          </>
        ) : (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Account workspace</Text>
            <Text style={styles.bodyText}>This account role does not have a workspace available.</Text>
          </View>
        )}

        {!(isCustomer && mainTab === "home") ? (
          <>
            {loading && (
              <View style={styles.loadingRow}>
                <ActivityIndicator color="#174A72" />
                <Text style={styles.muted}>Loading your NAVIGO workspace...</Text>
              </View>
            )}
            <Text style={styles.footer}>NAVIGO • Arua, Uganda</Text>
          </>
        ) : null}
      </ScrollView>
      {(activeSession.user.role === "CUSTOMER" || activeSession.user.role === "RIDER") && !(isCustomer && (keyboardVisible || activeLocationField !== null)) ? (
        <BottomNavigation role={activeSession.user.role} activeTab={mainTab} onChange={(nextTab) => {
          setMainTab(nextTab);
          if (nextTab === "home" && activeSession.user.role === "CUSTOMER") setTab("book");
        }} />
      ) : null}
    </SafeAreaView>
  );
}

type ProfileNotification = {
  id: string;
  title: string;
  body: string;
  requestType: "RIDE" | "PARCEL" | null;
  requestId: string | null;
  readAt: string | null;
  createdAt: string;
};

type ProfilePage = "home" | "account" | "preferences" | "notifications" | "workspace" | "support" | "privacy";

function ProfilePanel({
  session,
  onSignOut,
  signingOut,
  onSaveProfile,
  onChangePassword,
  onSwitchWorkspace,
  onApplyRider,
  refreshAccessToken,
  appearance,
  textSize,
  onUpdateUiPreferences
}: {
  session: Session;
  onSignOut: () => void;
  signingOut: boolean;
  onSaveProfile: (input: { fullName: string; email: string }) => Promise<void>;
  onChangePassword: (input: { currentPassword: string; newPassword: string }) => Promise<void>;
  onSwitchWorkspace: (role: "CUSTOMER" | "RIDER") => Promise<void>;
  onApplyRider: (input: { licenceNumber: string; motorcyclePlate: string; motorcycleDescription: string }) => Promise<void>;
  refreshAccessToken: () => Promise<string>;
  appearance: UiAppearance;
  textSize: UiTextSize;
  onUpdateUiPreferences: (changes: Partial<UiPreferences>) => Promise<void>;
}) {
  const roleLabel = session.user.role === "CUSTOMER" ? "Customer" : session.user.role === "RIDER" ? "Rider" : "Administrator";
  const riderStatus = session.user.riderApprovalStatus ?? "NOT SET";
  const [page, setPage] = useState<ProfilePage>("home");
  const [editing, setEditing] = useState(false);
  const [fullName, setFullName] = useState(session.user.fullName);
  const [email, setEmail] = useState(session.user.email ?? "");
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [licenceNumber, setLicenceNumber] = useState("");
  const [motorcyclePlate, setMotorcyclePlate] = useState("");
  const [motorcycleDescription, setMotorcycleDescription] = useState("");
  const [notifications, setNotifications] = useState<ProfileNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    setFullName(session.user.fullName);
    setEmail(session.user.email ?? "");
  }, [session.user.fullName, session.user.email]);

  useEffect(() => {
    if (page !== "notifications" && page !== "home") return;
    let active = true;
    setNotificationsLoading(true);
    apiRequest<{ data: { items: ProfileNotification[]; unreadCount: number } }>(
      "/api/v1/notifications",
      session.accessToken,
      {},
      refreshAccessToken
    ).then((result) => {
      if (!active) return;
      setNotifications(result.data.items);
      setUnreadCount(result.data.unreadCount);
      setError("");
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Notifications could not be loaded.");
    }).finally(() => {
      if (active) setNotificationsLoading(false);
    });
    return () => { active = false; };
  }, [page, session.accessToken, refreshAccessToken]);

  async function saveProfile() {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await onSaveProfile({ fullName: fullName.trim(), email: email.trim() });
      setEditing(false);
      setSuccess("Your profile has been updated.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn't update your profile. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function savePassword() {
    setError("");
    setSuccess("");
    if (newPassword !== confirmPassword) {
      setError("The new password and confirmation do not match.");
      return;
    }
    if (newPassword.length < 8) {
      setError("Your new password must contain at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await onChangePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowPasswordForm(false);
      setSuccess("Password changed. Other devices will need to sign in again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn't change your password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function updatePreferences(changes: Partial<UiPreferences>) {
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await onUpdateUiPreferences(changes);
      setSuccess("Your display preferences have been saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your preferences could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function submitRiderApplication() {
    setError("");
    setSuccess("");
    if (!licenceNumber.trim() || !motorcyclePlate.trim() || !motorcycleDescription.trim()) {
      setError("Complete your licence and motorcycle details before submitting.");
      return;
    }
    setBusy(true);
    try {
      await onApplyRider({
        licenceNumber: licenceNumber.trim(),
        motorcyclePlate: motorcyclePlate.trim().toUpperCase(),
        motorcycleDescription: motorcycleDescription.trim()
      });
      setSuccess("Your rider application has been submitted and is waiting for NAVIGO review.");
      setLicenceNumber("");
      setMotorcyclePlate("");
      setMotorcycleDescription("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Your rider application could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  async function changeWorkspace(role: "CUSTOMER" | "RIDER") {
    setError("");
    setBusy(true);
    try {
      await onSwitchWorkspace(role);
      setPage("home");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The workspace could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  async function markNotificationRead(notificationId: string) {
    try {
      await apiRequest<{ data: { id: string; read: boolean } }>(
        `/api/v1/notifications/${notificationId}/read`,
        session.accessToken,
        { method: "PATCH" },
        refreshAccessToken
      );
      setNotifications((current) => current.map((item) => item.id === notificationId
        ? { ...item, readAt: new Date().toISOString() }
        : item));
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This notification could not be updated.");
    }
  }

  async function markAllNotificationsRead() {
    try {
      await apiRequest<{ data: { updatedCount: number } }>(
        "/api/v1/notifications/read-all",
        session.accessToken,
        { method: "POST" },
        refreshAccessToken
      );
      const now = new Date().toISOString();
      setNotifications((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? now })));
      setUnreadCount(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Notifications could not be updated.");
    }
  }

  function menuItem(title: string, description: string, destination: ProfilePage, badgeText?: string) {
    return (
      <TouchableOpacity
        key={title}
        style={styles.profileMenuItem}
        accessibilityRole="button"
        onPress={() => { setError(""); setSuccess(""); setPage(destination); }}
      >
        <View style={styles.profileMenuCopy}>
          <Text style={styles.profileMenuTitle}>{title}</Text>
          <Text style={styles.profileMenuDescription}>{description}</Text>
        </View>
        {badgeText ? <Text style={styles.profileMenuBadge}>{badgeText}</Text> : null}
        <Text style={styles.profileMenuArrow}>›</Text>
      </TouchableOpacity>
    );
  }

  const pageTitle: Record<ProfilePage, string> = {
    home: "Profile",
    account: "My account",
    preferences: "Preferences",
    notifications: "Notifications",
    workspace: "NAVIGO workspace",
    support: "Help and support",
    privacy: "Privacy and about"
  };

  return (
    <View style={styles.profilePage}>
      {page === "home" ? (
        <>
          <View style={styles.profileHero}>
            <View style={styles.profileAvatar}>
              <Text style={styles.profileAvatarText}>{session.user.fullName.trim().charAt(0).toUpperCase() || "N"}</Text>
            </View>
            <Text style={styles.profileName}>{session.user.fullName}</Text>
            <Text style={styles.profileRole}>{roleLabel} workspace</Text>
            <Text style={styles.profileHint}>Manage your account, settings and NAVIGO services.</Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.profileMenuGroupTitle}>ACCOUNT</Text>
            {menuItem("Personal information and security", "Update your details and password", "account")}
            {menuItem("NAVIGO workspace", "Switch between customer and rider services", "workspace")}
          </View>
          <View style={styles.card}>
            <Text style={styles.profileMenuGroupTitle}>APP SETTINGS</Text>
            {menuItem("Preferences and accessibility", "Appearance, text size and notifications", "preferences")}
            {menuItem("Notifications", "Ride and item-delivery updates", "notifications", unreadCount > 0 ? String(unreadCount) : undefined)}
          </View>
          <View style={styles.card}>
            <Text style={styles.profileMenuGroupTitle}>HELP AND INFORMATION</Text>
            {menuItem("Help and support", "Answers to common questions", "support")}
            {menuItem("Privacy and about NAVIGO", "Permissions, data use and app information", "privacy")}
          </View>
          {error ? <Notice tone="error" text={error} /> : null}
          {success ? <Notice tone="success" text={success} /> : null}
          <TouchableOpacity style={styles.profileSignOut} onPress={onSignOut} disabled={signingOut || busy}>
            {signingOut ? <ActivityIndicator color="#B42318" /> : <Text style={styles.profileSignOutText}>Sign out of NAVIGO</Text>}
          </TouchableOpacity>
        </>
      ) : (
        <>
          <TouchableOpacity style={styles.profileBack} onPress={() => { setPage("home"); setError(""); setSuccess(""); }}>
            <Text style={styles.profileBackText}>‹  Profile</Text>
          </TouchableOpacity>
          <Text style={styles.profileSubTitle}>{pageTitle[page]}</Text>

          {page === "account" ? (
            <>
              <View style={styles.card}>
                <View style={styles.profileSectionHeader}>
                  <Text style={styles.cardTitle}>Personal information</Text>
                  <TouchableOpacity onPress={() => { setEditing((value) => !value); setError(""); setSuccess(""); }}>
                    <Text style={styles.profileActionText}>{editing ? "Cancel" : "Edit"}</Text>
                  </TouchableOpacity>
                </View>
                {editing ? (
                  <>
                    <Text style={styles.label}>Full name</Text>
                    <TextInput style={styles.addressInput} value={fullName} onChangeText={setFullName} placeholder="Your full name" placeholderTextColor="#98A2B3" autoCapitalize="words" />
                    <Text style={styles.label}>Email address</Text>
                    <TextInput style={styles.addressInput} value={email} onChangeText={setEmail} placeholder="name@example.com (optional)" placeholderTextColor="#98A2B3" keyboardType="email-address" autoCapitalize="none" />
                    <Text style={styles.profileHint}>Your phone number is used to sign in and identify your account, so it cannot be changed here without verification.</Text>
                    <PrimaryButton label="Save profile" loading={busy} onPress={saveProfile} disabled={busy || fullName.trim().length < 2} />
                  </>
                ) : (
                  <>
                    <Detail label="Full name" value={session.user.fullName} />
                    <Detail label="Phone number" value={session.user.phone} />
                    <Detail label="Email address" value={session.user.email || "Not added"} />
                    <Detail label="Account type" value={roleLabel} />
                  </>
                )}
              </View>

              {session.user.riderProfile ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Rider application</Text>
                  <Detail label="Application status" value={riderStatus.replace(/_/g, " ")} />
                  <Detail label="Driving licence" value={session.user.riderProfile.licenceNumber || "Not available"} />
                  <Detail label="Motorcycle" value={session.user.riderProfile.motorcycleDescription || "Not available"} />
                  <Detail label="Number plate" value={session.user.riderProfile.motorcyclePlate || "Not available"} />
                  <Text style={styles.profileHint}>Licence and motorcycle changes require NAVIGO review.</Text>
                </View>
              ) : null}

              <View style={styles.card}>
                <View style={styles.profileSectionHeader}>
                  <Text style={styles.cardTitle}>Account security</Text>
                  <TouchableOpacity onPress={() => { setShowPasswordForm((value) => !value); setError(""); setSuccess(""); }}>
                    <Text style={styles.profileActionText}>{showPasswordForm ? "Close" : "Change password"}</Text>
                  </TouchableOpacity>
                </View>
                {showPasswordForm ? (
                  <>
                    <Text style={styles.label}>Current password</Text>
                    <TextInput style={styles.addressInput} value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry placeholder="Enter current password" placeholderTextColor="#98A2B3" />
                    <Text style={styles.label}>New password</Text>
                    <TextInput style={styles.addressInput} value={newPassword} onChangeText={setNewPassword} secureTextEntry placeholder="At least 8 characters" placeholderTextColor="#98A2B3" />
                    <Text style={styles.label}>Confirm new password</Text>
                    <TextInput style={styles.addressInput} value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry placeholder="Enter the new password again" placeholderTextColor="#98A2B3" />
                    <PrimaryButton label="Update password" loading={busy} onPress={savePassword} disabled={busy || !currentPassword || !newPassword || !confirmPassword} />
                    <Text style={styles.profileHint}>For your security, other devices will need to sign in again when their current access token expires.</Text>
                  </>
                ) : (
                  <Text style={styles.profileInfoText}>Keep your password private and change it whenever you think it may have been exposed.</Text>
                )}
              </View>
            </>
          ) : null}

          {page === "workspace" ? (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Your current workspace</Text>
                <Detail label="Active workspace" value={roleLabel} />
                <Text style={styles.profileInfoText}>Your customer and rider activities remain linked to this same NAVIGO account.</Text>
                {session.user.role === "CUSTOMER" && session.user.riderApprovalStatus === "APPROVED" ? (
                  <PrimaryButton label="Switch to Rider workspace" loading={busy} onPress={() => changeWorkspace("RIDER")} disabled={busy} />
                ) : null}
                {session.user.role === "RIDER" ? (
                  <PrimaryButton label="Switch to Customer workspace" loading={busy} onPress={() => changeWorkspace("CUSTOMER")} disabled={busy} />
                ) : null}
              </View>
              {!session.user.riderProfile && session.user.role !== "ADMIN" ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Become a NAVIGO rider</Text>
                  <Text style={styles.profileInfoText}>Apply using your driving licence and motorcycle details. You can use your customer account while NAVIGO reviews your application.</Text>
                  <Text style={styles.label}>Driving licence number</Text>
                  <TextInput style={styles.addressInput} value={licenceNumber} onChangeText={setLicenceNumber} placeholder="Enter licence number" placeholderTextColor="#98A2B3" autoCapitalize="characters" />
                  <Text style={styles.label}>Motorcycle number plate</Text>
                  <TextInput style={styles.addressInput} value={motorcyclePlate} onChangeText={setMotorcyclePlate} placeholder="e.g. UXX 123X" placeholderTextColor="#98A2B3" autoCapitalize="characters" />
                  <Text style={styles.label}>Motorcycle description</Text>
                  <TextInput style={styles.addressInput} value={motorcycleDescription} onChangeText={setMotorcycleDescription} placeholder="Make, model and colour" placeholderTextColor="#98A2B3" />
                  <PrimaryButton label="Submit rider application" loading={busy} onPress={submitRiderApplication} disabled={busy} />
                </View>
              ) : null}
              {session.user.riderProfile && session.user.riderApprovalStatus !== "APPROVED" ? (
                <View style={styles.profileInfoCard}>
                  <Text style={styles.profileInfoTitle}>Rider application {riderStatus.toLowerCase()}</Text>
                  <Text style={styles.profileInfoText}>
                    {session.user.riderApprovalStatus === "PENDING"
                      ? "NAVIGO is reviewing your details. Rider workspace access will become available after approval."
                      : "Your rider application is not approved. Contact NAVIGO support for guidance before submitting another application."}
                  </Text>
                </View>
              ) : null}
            </>
          ) : null}

          {page === "preferences" ? (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Appearance</Text>
                <Text style={styles.profileInfoText}>Choose the appearance used throughout NAVIGO.</Text>
                <View style={styles.profileChoiceRow}>
                  {(["LIGHT", "DARK"] as UiAppearance[]).map((option) => (
                    <TouchableOpacity
                      key={option}
                      accessibilityRole="button"
                      accessibilityState={{ selected: appearance === option }}
                      style={[styles.profileChoiceButton, appearance === option && styles.profileChoiceButtonSelected]}
                      onPress={() => updatePreferences({ appearance: option })}
                      disabled={busy}
                    >
                      <Text style={[styles.profileChoiceText, appearance === option && styles.profileChoiceTextSelected]}>
                        {option === "LIGHT" ? "Light" : "Dark"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Detail label="Current appearance" value={appearance === "DARK" ? "Dark" : "Light"} />
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Text size</Text>
                <Text style={styles.profileInfoText}>Adjust text throughout NAVIGO. Your phone's accessibility font scaling remains supported too.</Text>
                <View style={styles.profileChoiceRow}>
                  {(["COMPACT", "STANDARD", "LARGE"] as UiTextSize[]).map((option) => (
                    <TouchableOpacity
                      key={option}
                      accessibilityRole="button"
                      accessibilityState={{ selected: textSize === option }}
                      style={[styles.profileChoiceButton, textSize === option && styles.profileChoiceButtonSelected]}
                      onPress={() => updatePreferences({ textSize: option })}
                      disabled={busy}
                    >
                      <Text style={[styles.profileChoiceText, textSize === option && styles.profileChoiceTextSelected]}>
                        {option === "COMPACT" ? "Small" : option === "STANDARD" ? "Standard" : "Large"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Detail label="Current text size" value={textSize === "COMPACT" ? "Small" : textSize === "LARGE" ? "Large" : "Standard"} />
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Notifications</Text>
                <Detail label="In-app notifications" value="Enabled" />
                <Detail label="Push notifications" value="Not configured on this build" />
                <Text style={styles.profileHint}>You can review ride and item-delivery updates in the Notifications section. Push alerts will require device registration and notification-service configuration.</Text>
              </View>
            </>
          ) : null}

          {page === "notifications" ? (
            <View style={styles.card}>
              <View style={styles.profileSectionHeader}>
                <Text style={styles.cardTitle}>Recent updates</Text>
                {unreadCount > 0 ? (
                  <TouchableOpacity onPress={markAllNotificationsRead}>
                    <Text style={styles.profileActionText}>Mark all read</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              {notificationsLoading ? (
                <ActivityIndicator color="#174A72" style={{ marginVertical: 22 }} />
              ) : notifications.length ? notifications.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.notificationItem, !item.readAt && styles.notificationItemUnread]}
                  onPress={() => !item.readAt && markNotificationRead(item.id)}
                  accessibilityRole="button"
                >
                  <View style={styles.notificationHeader}>
                    <Text style={styles.notificationTitle}>{item.title}</Text>
                    {!item.readAt ? <View style={styles.notificationUnreadDot} /> : null}
                  </View>
                  <Text style={styles.profileInfoText}>{item.body}</Text>
                  <Text style={styles.notificationMeta}>
                    {item.requestType === "RIDE" ? "Ride" : item.requestType === "PARCEL" ? "Item delivery" : "NAVIGO"}
                    {"  •  "}{new Date(item.createdAt).toLocaleString()}
                  </Text>
                </TouchableOpacity>
              )) : (
                <EmptyState title="You're all caught up" text="Ride and item-delivery updates will appear here." />
              )}
            </View>
          ) : null}

          {page === "support" ? (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Ride bookings</Text>
                <Text style={styles.profileInfoText}>After you submit a ride request, NAVIGO looks for an available nearby rider. You can track the request and cancel it while cancellation is available in the app.</Text>
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Item deliveries</Text>
                <Text style={styles.profileInfoText}>Keep your pickup and delivery verification codes safe. Give each code only to the assigned rider at the matching collection or delivery step.</Text>
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Payments</Text>
                <Text style={styles.profileInfoText}>Pay the rider directly using the payment method selected for the request. NAVIGO does not collect or hold customer payments in this version.</Text>
              </View>
              <View style={styles.profileInfoCard}>
                <Text style={styles.profileInfoTitle}>Need more help?</Text>
                <Text style={styles.profileInfoText}>Official NAVIGO support phone and email details have not yet been configured in this build, so no unverified contact details are shown here.</Text>
              </View>
            </>
          ) : null}

          {page === "privacy" ? (
            <>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Location and permissions</Text>
                <Text style={styles.profileInfoText}>Location is used to set pickup points, calculate routes and match nearby riders. Rider availability location is shared while the rider is online and using NAVIGO.</Text>
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Account information</Text>
                <Text style={styles.profileInfoText}>Your name, phone number and optional email identify your account. Keep your password private and never share it with a rider or another user.</Text>
              </View>
              <View style={styles.card}>
                <Text style={styles.cardTitle}>About NAVIGO</Text>
                <Detail label="App" value="NAVIGO" />
                <Detail label="Version" value="1.0.0" />
                <Detail label="Pilot area" value="Arua, Uganda" />
              </View>
              <View style={styles.profileInfoCard}>
                <Text style={styles.profileInfoTitle}>Legal documents</Text>
                <Text style={styles.profileInfoText}>The final published Terms of Service and full Privacy Policy must be added before public launch. This screen is an in-app data-use summary, not a replacement for those documents.</Text>
              </View>
            </>
          ) : null}

          {error ? <Notice tone="error" text={error} /> : null}
          {success ? <Notice tone="success" text={success} /> : null}
        </>
      )}
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.profileDetailRow}>
      <Text style={styles.profileDetailLabel}>{label}</Text>
      <Text style={styles.profileDetailValue}>{value}</Text>
    </View>
  );
}

function BottomNavigation({ role, activeTab, onChange }: {
  role: "CUSTOMER" | "RIDER";
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  const items: { key: WorkspaceTab; label: string; icon: string }[] = role === "CUSTOMER"
    ? [
        { key: "home", label: "Home", icon: "⌂" },
        { key: "activity", label: "Activity", icon: "▤" },
        { key: "profile", label: "Profile", icon: "◉" }
      ]
    : [
        { key: "home", label: "Home", icon: "⌂" },
        { key: "requests", label: "Requests", icon: "⌖" },
        { key: "jobs", label: "My jobs", icon: "▣" },
        { key: "profile", label: "Profile", icon: "◉" }
      ];
  return (
    <View style={styles.bottomNav}>
      {items.map((item) => {
        const selected = activeTab === item.key;
        return (
          <TouchableOpacity key={item.key} accessibilityRole="button" accessibilityLabel={item.label} accessibilityState={{ selected }} style={styles.bottomNavItem} onPress={() => onChange(item.key)}>
            <Text style={[styles.bottomNavIcon, selected && styles.bottomNavIconSelected]}>{item.icon}</Text>
            <Text style={[styles.bottomNavLabel, selected && styles.bottomNavLabelSelected]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
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
  if (!visible || !query.trim()) return null;

  const normalized = query.trim().toLowerCase();
  const matches = ARUA_LOCATION_SUGGESTIONS
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

  return (
    <View style={styles.suggestionList}>
      <View style={styles.suggestionTitleRow}>
        <Text style={styles.suggestionHeading}>SUGGESTED ARUA PLACES</Text>
      </View>
      {matches.length ? matches.map((suggestion) => (
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
      )) : (
        <Text style={styles.noSuggestionText}>
          No saved suggestion matched. You can still enter the full place name and tap Show road route &amp; fare to search the Arua map.
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
  onAdvance,
  paymentReference,
  onPaymentReferenceChange,
  onRecordPayment
}: {
  ride: Ride;
  customerView?: boolean;
  riderView?: boolean;
  busy?: boolean;
  onCancel?: () => void;
  onAccept?: () => void;
  onAdvance?: () => void;
  paymentReference?: string;
  onPaymentReferenceChange?: (value: string) => void;
  onRecordPayment?: () => void;
}) {
  const canCancel = customerView && (ride.status === "PENDING" || ride.status === "ACCEPTED");
  const riderStatusLabels: Record<string, string> = {
    PENDING: "Nearby ride request",
    ACCEPTED: "You accepted this ride",
    ARRIVED_AT_PICKUP: "You are at pickup",
    IN_PROGRESS: "Journey in progress",
    COMPLETED: "Ride completed",
    CANCELLED: "Ride cancelled",
    EXPIRED: "Ride expired"
  };
  const nextLabel: Record<string, string> = {
    ACCEPTED: "Confirm arrival at pickup",
    ARRIVED_AT_PICKUP: "Start trip",
    IN_PROGRESS: "Complete trip"
  };
  return (
    <View style={styles.rideCard}>
      <View style={styles.rideTopRow}>
        <Text style={styles.rideStatus}>{riderView ? (riderStatusLabels[ride.status] ?? ride.status) : (STATUS_LABELS[ride.status] ?? ride.status)}</Text>
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
        {formatDistance(ride.estimatedDistanceKm)} • {ride.payment?.method === "MOBILE_MONEY" ? "Mobile Money" : "Cash"} • {ride.payment?.status === "PAID" ? "Paid" : "Payment not yet recorded"}
      </Text>
      {riderView && ride.status === "COMPLETED" && ride.payment?.status === "UNPAID" && onRecordPayment ? (
        <View style={styles.codeEntryPanel}>
          {ride.payment.method === "MOBILE_MONEY" ? (
            <>
              <Text style={styles.label}>Mobile Money transaction reference (optional)</Text>
              <TextInput style={styles.addressInput} value={paymentReference} onChangeText={onPaymentReferenceChange} autoCapitalize="characters" placeholder="e.g. transfer receipt reference" placeholderTextColor="#98A2B3" />
            </>
          ) : null}
          <Text style={styles.trackingPrivacyText}>Confirm only after receiving the cash or checking the Mobile Money transfer. NAVIGO does not verify transfers automatically.</Text>
          <PrimaryButton label="Confirm payment received" loading={busy} onPress={onRecordPayment} disabled={busy} />
        </View>
      ) : null}
      {customerView && ride.rider ? (
        <View style={styles.assignedRider}>
          <Text style={styles.assignedLabel}>YOUR RIDER</Text>
          <Text style={styles.assignedName}>{ride.rider.fullName}</Text>
          <Text style={styles.rideMeta}>{ride.rider.phone}{ride.rider.riderProfile?.motorcyclePlate ? ` • ${ride.rider.riderProfile.motorcyclePlate}` : ""}</Text>
        </View>
      ) : null}
      {customerView && ride.status === "PENDING" ? (
        <View style={styles.trackingPanel}>
          <Text style={styles.trackingStatusText}>Finding a nearby rider</Text>
          <Text style={styles.trackingPrivacyText}>NAVIGO is matching your pickup location with approved riders nearby. This request is sent only to riders within the current matching area.</Text>
        </View>
      ) : null}
      {customerView && ride.status === "ACCEPTED" ? (
        <View style={styles.trackingPanel}>
          <Text style={styles.trackingStatusText}>Your rider is confirmed and on the way.</Text>
          {typeof ride.riderArrivalEstimateMinutes === "number"
            ? <Text style={styles.assignedName}>Estimated arrival: about {ride.riderArrivalEstimateMinutes} minute{ride.riderArrivalEstimateMinutes === 1 ? "" : "s"}</Text>
            : <Text style={styles.trackingPrivacyText}>Your rider has accepted the request. An arrival estimate is not available right now.</Text>}
          <Text style={styles.trackingPrivacyText}>This is an estimate based on the motorcycle route and may change with road conditions or delays.</Text>
        </View>
      ) : null}
      {customerView && ride.status === "ARRIVED_AT_PICKUP" ? (
        <View style={styles.trackingPanel}>
          <Text style={styles.trackingStatusText}>Your rider has arrived at the pickup point.</Text>
          <Text style={styles.trackingPrivacyText}>Please meet your rider at the agreed pickup location.</Text>
        </View>
      ) : null}
      {customerView && ride.status === "IN_PROGRESS" ? (
        <View style={styles.trackingPanel}>
          <Text style={styles.trackingStatusText}>Your trip is in progress.</Text>
          <Text style={styles.trackingPrivacyText}>Your rider has started the journey to your destination.</Text>
        </View>
      ) : null}
      {customerView && ride.status === "COMPLETED" ? (
        <View style={styles.trackingPanel}>
          <Text style={styles.trackingStatusText}>This ride has been completed.</Text>
          <Text style={styles.trackingPrivacyText}>{ride.payment?.status === "PAID" ? "Payment is recorded as paid." : "Payment has not yet been recorded."}</Text>
        </View>
      ) : null}
      {customerView && ["CANCELLED", "EXPIRED"].includes(ride.status) ? (
        <View style={styles.trackingPanel}>
          <Text style={styles.trackingStatusText}>{ride.status === "CANCELLED" ? "This ride was cancelled." : "This ride request expired."}</Text>
        </View>
      ) : null}
      {riderView && typeof ride.pickupDistanceKm === "number" ? <Text style={styles.rideMeta}>Pickup is about {ride.pickupDistanceKm.toFixed(1)} km away in a straight line</Text> : null}
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

function parcelTrackingRegion(tracking: ParcelTracking) {
  const points = [tracking.pickup, tracking.destination, ...(tracking.rider ? [tracking.rider] : [])];
  return routeMapRegion(points);
}

function CustomerParcelCard({
  parcel,
  tracking,
  busy,
  onCancel
}: {
  parcel: RiderParcel;
  tracking: ParcelTracking | null;
  busy: boolean;
  onCancel?: () => void;
}) {
  const labels: Record<string, string> = {
    PENDING: "Finding a rider",
    ACCEPTED: "Rider assigned",
    ARRIVED_AT_PICKUP: "Rider at pickup",
    COLLECTED: "Item collected",
    IN_TRANSIT: "On the way to recipient",
    ARRIVED_AT_DESTINATION: "Rider at delivery point",
    DELIVERED: "Successfully delivered",
    CANCELLED: "Cancelled",
    EXPIRED: "Request expired"
  };
  const steps = ["PENDING", "ACCEPTED", "ARRIVED_AT_PICKUP", "COLLECTED", "IN_TRANSIT", "ARRIVED_AT_DESTINATION", "DELIVERED"];
  const current = steps.indexOf(parcel.status);
  return (
    <View style={styles.rideCard}>
      <View style={styles.rideTopRow}>
        <Text style={styles.rideStatus}>{labels[parcel.status] ?? parcel.status}</Text>
        <Text style={styles.rideFare}>{money(parcel.fareAmountUgx)}</Text>
      </View>
      <Text style={styles.rideMeta}>{parcel.sizeCategory} item • {formatDistance(parcel.estimatedDistanceKm)} • {parcel.payment?.method === "MOBILE_MONEY" ? "Mobile Money" : "Cash"} • {parcel.payment?.status === "PAID" ? "Paid" : "Payment not yet recorded"}</Text>
      <Text style={styles.label}>ITEM</Text>
      <Text style={styles.routeAddress}>{parcel.parcelDescription}</Text>
      <View style={styles.routeRow}>
        <View style={styles.routeMarkers}>
          <View style={styles.pickupDot} />
          <View style={styles.routeLine} />
          <View style={styles.destinationDot} />
        </View>
        <View style={styles.routeTexts}>
          <Text style={styles.routeLabel}>PICKUP</Text>
          <Text style={styles.routeAddress}>{parcel.pickupDescription}</Text>
          <Text style={[styles.routeLabel, styles.destinationLabel]}>DELIVERY</Text>
          <Text style={styles.routeAddress}>{parcel.destinationDescription}</Text>
        </View>
      </View>
      {tracking && ACTIVE_TRACKING_STATUSES.includes(parcel.status) ? (
        <View style={styles.trackingPanel}>
          <Text style={styles.label}>RIDER LOCATION</Text>
          <View style={styles.trackingMapFrame}>
            <SafeMapView
              style={styles.routeMap}
              initialRegion={parcelTrackingRegion(tracking)}
              routeCoordinates={[tracking.pickup, tracking.destination]}
              markers={[{ coordinate: tracking.pickup, title: "Pickup", pinColor: "#21865B" }, { coordinate: tracking.destination, title: "Delivery", pinColor: "#C54848" }, { coordinate: tracking.rider, title: "Rider", pinColor: "#236B9A" }]}
              customMapStyle={LIGHT_MAP_STYLE}
              scrollEnabled
              zoomEnabled
              rotateEnabled={false}
              pitchEnabled={false}
              toolbarEnabled={false}
              showsCompass={false}
              showsScale={false}
            >
              <Marker coordinate={tracking.pickup} title="Pickup point" pinColor="#21865B" />
              <Marker coordinate={tracking.destination} title="Delivery point" pinColor="#C54848" />
              {tracking.rider ? (
                <Marker coordinate={tracking.rider} title="Rider's latest location" description="Last reported GPS position" pinColor="#236B9A" />
              ) : null}
            </SafeMapView>
          </View>
          <Text style={styles.trackingStatusText}>
            {tracking.rider
              ? `Rider location updated at ${new Date(tracking.rider.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : tracking.sharingEnabled
                ? "Waiting for the rider's next GPS update. Keep this screen open to refresh."
                : "The rider has not enabled live location sharing yet."}
          </Text>
          <Text style={styles.trackingPrivacyText}>Only you, as the sender, can view the rider's shared location. A position older than two minutes is hidden.</Text>
        </View>
      ) : null}
      <View style={styles.progressPanel}>
        <Text style={styles.label}>DELIVERY PROGRESS</Text>
        {steps.map((step, index) => (
          <View key={step} style={styles.progressRow}>
            <View style={[styles.progressDot, index <= current && parcel.status !== "CANCELLED" ? styles.progressDotDone : null]} />
            <Text style={[styles.progressText, index <= current && parcel.status !== "CANCELLED" ? styles.progressTextDone : null]}>{labels[step]}</Text>
          </View>
        ))}
      </View>
      {parcel.rider ? (
        <View style={styles.assignedRider}>
          <Text style={styles.assignedLabel}>YOUR RIDER</Text>
          <Text style={styles.assignedName}>{parcel.rider.fullName}</Text>
          <Text style={styles.rideMeta}>{parcel.rider.phone}{parcel.rider.riderProfile?.motorcyclePlate ? ` • ${parcel.rider.riderProfile.motorcyclePlate}` : ""}</Text>
        </View>
      ) : null}
      <Text style={styles.rideMeta}>Recipient: {parcel.recipientName} • {parcel.recipientPhone}</Text>
      {parcel.history?.length ? (
        <View style={styles.historyNotes}>
          <Text style={styles.label}>LATEST UPDATE</Text>
          <Text style={styles.rideMeta}>{parcel.history[parcel.history.length - 1]?.note || labels[parcel.status] || parcel.status}</Text>
        </View>
      ) : null}
      {onCancel ? <TouchableOpacity onPress={onCancel} disabled={busy} style={styles.cancelButton}><Text style={styles.cancelText}>Cancel item delivery</Text></TouchableOpacity> : null}
    </View>
  );
}

function ParcelRiderCard({
  parcel,
  busy,
  code,
  onCodeChange,
  onAccept,
  onAdvance,
  onVerifyPickup,
  onVerifyDelivery,
  trackingEnabled,
  onToggleTracking,
  paymentReference,
  onPaymentReferenceChange,
  onRecordPayment
}: {
  parcel: RiderParcel;
  busy: boolean;
  code?: string;
  trackingEnabled?: boolean;
  onToggleTracking?: () => void;
  onCodeChange?: (value: string) => void;
  onAccept?: () => void;
  onAdvance?: () => void;
  onVerifyPickup?: () => void;
  onVerifyDelivery?: () => void;
  paymentReference?: string;
  onPaymentReferenceChange?: (value: string) => void;
  onRecordPayment?: () => void;
}) {
  const statusLabels: Record<string, string> = {
    PENDING: "Waiting for a rider",
    ACCEPTED: "You accepted this delivery",
    ARRIVED_AT_PICKUP: "You are at the pickup point",
    COLLECTED: "Item collected",
    IN_TRANSIT: "On the way to recipient",
    ARRIVED_AT_DESTINATION: "You are at the delivery point",
    DELIVERED: "Successfully delivered",
    CANCELLED: "Cancelled",
    EXPIRED: "Expired"
  };
  const nextLabels: Record<string, string> = {
    ACCEPTED: "I have arrived at pickup",
    COLLECTED: "Start delivery journey",
    IN_TRANSIT: "I have arrived at destination"
  };
  const needsPickupCode = parcel.status === "ARRIVED_AT_PICKUP";
  const needsDeliveryCode = parcel.status === "ARRIVED_AT_DESTINATION";
  return (
    <View style={styles.rideCard}>
      <View style={styles.rideTopRow}>
        <Text style={styles.rideStatus}>{statusLabels[parcel.status] ?? parcel.status}</Text>
        <Text style={styles.rideFare}>{money(parcel.fareAmountUgx)}</Text>
      </View>
      <Text style={styles.rideMeta}>{parcel.sizeCategory} item • {formatDistance(parcel.estimatedDistanceKm)} • {parcel.payment?.method === "MOBILE_MONEY" ? "Mobile Money" : "Cash"} • {parcel.payment?.status === "PAID" ? "Paid" : "Payment not yet recorded"}</Text>
      <Text style={styles.label}>ITEM</Text>
      <Text style={styles.routeAddress}>{parcel.parcelDescription}</Text>
      <View style={styles.routeRow}>
        <View style={styles.routeMarkers}>
          <View style={styles.pickupDot} />
          <View style={styles.routeLine} />
          <View style={styles.destinationDot} />
        </View>
        <View style={styles.routeTexts}>
          <Text style={styles.routeLabel}>PICKUP</Text>
          <Text style={styles.routeAddress}>{parcel.pickupDescription}</Text>
          <Text style={[styles.routeLabel, styles.destinationLabel]}>DELIVERY</Text>
          <Text style={styles.routeAddress}>{parcel.destinationDescription}</Text>
        </View>
      </View>
      {parcel.recipientPhone ? (
        <Text style={styles.rideMeta}>Recipient: {parcel.recipientName} • {parcel.recipientPhone}</Text>
      ) : (
        <Text style={styles.rideMeta}>Recipient details are shared after you accept this delivery</Text>
      )}
      {parcel.sender?.fullName ? <Text style={styles.rideMeta}>Sender: {parcel.sender.fullName}</Text> : null}
      {onToggleTracking ? (
        <View style={styles.trackingControlPanel}>
          <Text style={styles.trackingPrivacyText}>Live location is shared with this item's sender only. Sharing works while NAVIGO remains open.</Text>
          <PrimaryButton
            label={trackingEnabled ? "Stop live location sharing" : "Enable live location sharing"}
            loading={busy}
            onPress={onToggleTracking}
            disabled={busy}
          />
        </View>
      ) : null}
      {onAccept ? <PrimaryButton label="Accept item delivery" loading={busy} onPress={onAccept} disabled={busy} /> : null}
      {onAdvance ? <PrimaryButton label={nextLabels[parcel.status] ?? "Update delivery"} loading={busy} onPress={onAdvance} disabled={busy} /> : null}
      {needsPickupCode && onVerifyPickup ? (
        <View style={styles.codeEntryPanel}>
          <Text style={styles.label}>Enter sender's 6-digit pickup code</Text>
          <TextInput style={styles.addressInput} value={code} onChangeText={onCodeChange} keyboardType="number-pad" maxLength={6} placeholder="Pickup code" placeholderTextColor="#98A2B3" />
          <PrimaryButton label="Verify collection" loading={busy} onPress={onVerifyPickup} disabled={busy || (code ?? "").length !== 6} />
        </View>
      ) : null}
      {needsDeliveryCode && onVerifyDelivery ? (
        <View style={styles.codeEntryPanel}>
          <Text style={styles.label}>Enter recipient's 6-digit delivery code</Text>
          <TextInput style={styles.addressInput} value={code} onChangeText={onCodeChange} keyboardType="number-pad" maxLength={6} placeholder="Delivery code" placeholderTextColor="#98A2B3" />
          <PrimaryButton label="Verify delivery" loading={busy} onPress={onVerifyDelivery} disabled={busy || (code ?? "").length !== 6} />
        </View>
      ) : null}
      {parcel.status === "DELIVERED" && parcel.payment?.status === "UNPAID" && onRecordPayment ? (
        <View style={styles.codeEntryPanel}>
          {parcel.payment.method === "MOBILE_MONEY" ? (
            <>
              <Text style={styles.label}>Mobile Money transaction reference (optional)</Text>
              <TextInput style={styles.addressInput} value={paymentReference} onChangeText={onPaymentReferenceChange} autoCapitalize="characters" placeholder="e.g. transfer receipt reference" placeholderTextColor="#98A2B3" />
            </>
          ) : null}
          <Text style={styles.trackingPrivacyText}>Confirm only after receiving the cash or checking the Mobile Money transfer. NAVIGO does not verify transfers automatically.</Text>
          <PrimaryButton label="Confirm payment received" loading={busy} onPress={onRecordPayment} disabled={busy} />
        </View>
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

const LIGHT_MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#F1F5F8" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#536575" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#FFFFFF" }] },
  { featureType: "administrative", elementType: "geometry.stroke", stylers: [{ color: "#D6E0E8" }] },
  { featureType: "poi", elementType: "geometry", stylers: [{ color: "#E5EDF2" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#DDEBDD" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#FFFFFF" }] },
  { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#FFFFFF" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#F9DFAF" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#E4EAF0" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#CFE3EF" }] }
];

const baseStyles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F3F6FA" },
  mainScroll: { flex: 1 },
  page: { flexGrow: 1, paddingHorizontal: 19, paddingTop: 20, paddingBottom: 30 },
  topBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20 },
  brandSmall: { color: "#174A72", fontSize: 12, fontWeight: "900", letterSpacing: 2 },
  greeting: { color: "#142B3D", fontSize: 24, fontWeight: "800", marginTop: 4 },
  muted: { color: "#8793A2", fontSize: 12, marginTop: 4 },
  signOut: { borderWidth: 1, borderColor: "#D5DFE8", paddingHorizontal: 13, paddingVertical: 9, borderRadius: 10, backgroundColor: "#FFFFFF" },
  signOutText: { color: "#174A72", fontWeight: "700", fontSize: 12 },
  bottomNav: { flexDirection: "row", alignItems: "center", justifyContent: "space-around", backgroundColor: "#FFFFFF", borderTopWidth: 1, borderTopColor: "#E5EAF0", paddingTop: 7, paddingBottom: 8, paddingHorizontal: 8 },
  bottomNavItem: { flex: 1, minHeight: 49, alignItems: "center", justifyContent: "center", gap: 3 },
  bottomNavIcon: { color: "#98A2B3", fontSize: 20, lineHeight: 22, fontWeight: "700" },
  bottomNavIconSelected: { color: "#174A72" },
  bottomNavLabel: { color: "#8793A2", fontSize: 10, fontWeight: "600" },
  bottomNavLabelSelected: { color: "#174A72", fontWeight: "900" },
  profilePage: { gap: 13 },
  profileHero: { alignItems: "center", backgroundColor: "#FFFFFF", borderRadius: 18, padding: 22, borderWidth: 1, borderColor: "#E5EAF0" },
  profileAvatar: { width: 66, height: 66, borderRadius: 33, backgroundColor: "#EAF3F9", alignItems: "center", justifyContent: "center", marginBottom: 11 },
  profileAvatarText: { color: "#174A72", fontSize: 29, fontWeight: "900" },
  profileName: { color: "#142B3D", fontSize: 19, fontWeight: "900" },
  profileRole: { color: "#667085", fontSize: 12, marginTop: 5 },
  profileSectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  profileMenuGroupTitle: { color: "#98A2B3", fontSize: 9, fontWeight: "900", letterSpacing: 1.2, marginBottom: 2 },
  profileMenuItem: { minHeight: 62, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 11, borderTopWidth: 1, borderTopColor: "#F0F2F5" },
  profileMenuCopy: { flex: 1 },
  profileMenuTitle: { color: "#243B4D", fontSize: 12, fontWeight: "800" },
  profileMenuDescription: { color: "#8793A2", fontSize: 10, lineHeight: 15, marginTop: 3 },
  profileMenuBadge: { color: "#FFFFFF", backgroundColor: "#236B9A", overflow: "hidden", borderRadius: 9, paddingHorizontal: 7, paddingVertical: 3, fontSize: 9, fontWeight: "900" },
  profileMenuArrow: { color: "#98A2B3", fontSize: 23, fontWeight: "400" },
  profileBack: { alignSelf: "flex-start", paddingVertical: 5, paddingRight: 12 },
  profileBackText: { color: "#236B9A", fontSize: 12, fontWeight: "800" },
  profileSubTitle: { color: "#142B3D", fontSize: 20, fontWeight: "900", marginBottom: 2 },
  profileChoiceRow: { flexDirection: "row", gap: 7, marginTop: 11, marginBottom: 9 },
  profileChoiceButton: { flex: 1, minHeight: 40, borderRadius: 10, borderWidth: 1, borderColor: "#DCE3EB", backgroundColor: "#FBFCFE", alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  profileChoiceButtonSelected: { borderColor: "#236B9A", backgroundColor: "#EAF3F9" },
  profileChoiceText: { color: "#667085", fontSize: 11, fontWeight: "700" },
  profileChoiceTextSelected: { color: "#174A72", fontWeight: "900" },
  notificationItem: { paddingVertical: 13, borderTopWidth: 1, borderTopColor: "#F0F2F5" },
  notificationItemUnread: { backgroundColor: "#F7FAFC", marginHorizontal: -4, paddingHorizontal: 4, borderRadius: 8 },
  notificationHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  notificationTitle: { color: "#243B4D", fontSize: 12, fontWeight: "800", flex: 1 },
  notificationUnreadDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#236B9A" },
  notificationMeta: { color: "#98A2B3", fontSize: 9, marginTop: 7 },
  profileActionText: { color: "#236B9A", fontSize: 12, fontWeight: "800" },
  profileHint: { color: "#8793A2", fontSize: 10, lineHeight: 15, marginTop: 7 },

  profileDetailRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#F0F2F5" },
  profileDetailLabel: { color: "#8793A2", fontSize: 11, flex: 1 },
  profileDetailValue: { color: "#344054", fontSize: 11, fontWeight: "700", flex: 1, textAlign: "right" },
  profileInfoCard: { backgroundColor: "#F0F7FC", borderRadius: 14, borderWidth: 1, borderColor: "#D3E6F3", padding: 14 },
  profileInfoTitle: { color: "#174A72", fontSize: 13, fontWeight: "900" },
  profileInfoText: { color: "#526779", fontSize: 11, lineHeight: 17, marginTop: 6 },
  profileSignOut: { minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: "#F2C7C4", backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  profileSignOutText: { color: "#B42318", fontSize: 12, fontWeight: "800" },
  quickAccessRow: { flexDirection: "row", gap: 10, marginTop: 2, marginBottom: 14 },
  quickAccessCard: { flex: 1, minHeight: 92, backgroundColor: "#FFFFFF", borderRadius: 14, borderWidth: 1, borderColor: "#E5EAF0", padding: 13, justifyContent: "center" },
  quickAccessTitle: { color: "#174A72", fontSize: 13, fontWeight: "900" },
  quickAccessText: { color: "#667085", fontSize: 10, lineHeight: 15, marginTop: 5 },
  mapHomePage: { flexGrow: 1, paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0 },
  customerMapFrame: { height: Dimensions.get("window").height - 88, borderRadius: 0, overflow: "hidden", marginBottom: 0, marginHorizontal: 0, marginTop: 0, borderWidth: 0, backgroundColor: "#E9F0F5", position: "relative" },
  customerMapSheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: "#FFFFFF", borderTopLeftRadius: 23, borderTopRightRadius: 23, overflow: "hidden", elevation: 18, shadowColor: "#102A43", shadowOpacity: 0.17, shadowRadius: 14 },
  customerMapSearchMapHidden: { position: "absolute", top: 0, left: 0, right: 0, opacity: 0, zIndex: -1 },
  customerMapSearchSheet: { marginTop: 0, marginHorizontal: 0, marginBottom: 0, borderRadius: 0, elevation: 2, zIndex: 2, shadowOpacity: 0 },
  locationSearchHeader: { minHeight: 58, flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: "#E5EAF0", backgroundColor: "#FFFFFF" },
  locationSearchBackButton: { position: "absolute", left: 14, top: 4, width: 42, height: 50, justifyContent: "center" },
  locationSearchBackText: { color: "#174A72", fontSize: 34, lineHeight: 38, fontWeight: "400" },
  locationSearchTitle: { color: "#182230", fontSize: 16, fontWeight: "800" },
  locationSearchLocationAction: { minHeight: 42, justifyContent: "center", paddingHorizontal: 4, marginTop: 4, marginBottom: 4 },
  locationSearchLocationActionText: { color: "#174A72", fontSize: 12, fontWeight: "800" },
  mapSheetDragArea: { paddingTop: 10, paddingHorizontal: 16, paddingBottom: 10 },
  mapSheetGrip: { alignSelf: "center", width: 42, height: 5, borderRadius: 3, backgroundColor: "#C8D0D8", marginBottom: 11 },
  mapSheetWhereTo: { minHeight: 54, borderRadius: 14, backgroundColor: "#F4F6F8", paddingHorizontal: 15, paddingVertical: 9, justifyContent: "center" },
  mapSheetWhereToText: { color: "#142B3D", fontSize: 15, fontWeight: "800" },
  mapSheetPickupSummary: { color: "#667085", fontSize: 10, marginTop: 3 },
  mapSheetScroll: { flex: 1 },
  mapSheetContent: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 24 },
  routeReviewLocations: { backgroundColor: "#F7F9FB", borderRadius: 13, paddingHorizontal: 12, paddingVertical: 10, marginTop: 9, gap: 10 },
  routeReviewStop: { flexDirection: "row", alignItems: "center", gap: 10 },
  routeReviewStopCopy: { flex: 1 },
  routeReviewAddress: { color: "#344054", fontSize: 12, fontWeight: "700", lineHeight: 17, marginTop: 2 },
  quoteEditButton: { minHeight: 42, borderRadius: 10, borderWidth: 1, borderColor: "#D5E2EB", alignItems: "center", justifyContent: "center", marginTop: 8, marginBottom: 10, backgroundColor: "#FFFFFF" },
  quoteEditButtonText: { color: "#174A72", fontSize: 11, fontWeight: "800" },
  customerMapRecenterButton: { position: "absolute", top: 112, right: 13, width: 42, height: 42, borderRadius: 21, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", elevation: 4, shadowColor: "#102A43", shadowOpacity: 0.16, shadowRadius: 7 },
  mapLocationRetryPill: { left: 13, right: undefined, top: 61 },
  riderMapFrame: { height: Dimensions.get("window").height * 0.48, borderRadius: 18, overflow: "hidden", marginTop: 12, marginBottom: 12, backgroundColor: "#E9F0F5", position: "relative" },
  riderMapStatus: { position: "absolute", left: 13, bottom: 13, backgroundColor: "#FFFFFF", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 7, elevation: 3 },
  riderOnlineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#98A2B3" },
  riderOnlineDotActive: { backgroundColor: "#12B76A" },
  riderMapStatusText: { color: "#344054", fontSize: 10, fontWeight: "800" },
  mapSelectionControls: { position: "absolute", top: 13, right: 12, gap: 7, alignItems: "flex-end" },
  mapRecenterButton: { position: "absolute", right: 13, bottom: 80, width: 42, height: 42, borderRadius: 21, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", elevation: 4, shadowColor: "#102A43", shadowOpacity: 0.16, shadowRadius: 7 },
  mapRecenterText: { color: "#174A72", fontSize: 23, fontWeight: "800", lineHeight: 26 },
  riderMapRecenterButton: { bottom: 120 },
  riderDirectionsButton: { position: "absolute", right: 12, bottom: 60, backgroundColor: "#174A72", borderRadius: 20, paddingHorizontal: 13, paddingVertical: 10, elevation: 4 },
  riderDirectionsText: { color: "#FFFFFF", fontSize: 10, fontWeight: "800" },
  mapSelectionButton: { backgroundColor: "#FFFFFF", borderRadius: 18, paddingHorizontal: 12, paddingVertical: 9, elevation: 3 },
  mapSelectionButtonActive: { backgroundColor: "#174A72" },
  mapSelectionButtonText: { color: "#344054", fontSize: 10, fontWeight: "800" },
  mapSelectionButtonTextActive: { color: "#FFFFFF" },
  mapSelectionHint: { position: "absolute", bottom: 78, left: 12, right: 12, backgroundColor: "rgba(23,74,114,0.96)", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  mapSelectionHintAboveSheet: { bottom: 180 },
  mapSelectionHintText: { color: "#FFFFFF", fontSize: 10, fontWeight: "700", flex: 1 },
  mapSelectionCancel: { color: "#FFFFFF", fontSize: 10, fontWeight: "900" },
  pickupLocationPill: { position: "absolute", left: 12, right: 12, bottom: 12, backgroundColor: "#FFFFFF", borderRadius: 15, padding: 11, flexDirection: "row", alignItems: "center", shadowColor: "#102A43", shadowOpacity: 0.15, shadowRadius: 10, elevation: 4 },
  pickupLocationCopy: { flex: 1, paddingRight: 8 },
  pickupLocationLabel: { color: "#8793A2", fontSize: 8, fontWeight: "900", letterSpacing: 1 },
  pickupLocationValue: { color: "#142B3D", fontSize: 12, fontWeight: "700", marginTop: 4 },
  locationChangeButton: { backgroundColor: "#EDF5FA", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9 },
  locationChangeText: { color: "#174A72", fontSize: 11, fontWeight: "800" },
  locationRetryPill: { position: "absolute", top: 57, right: 12, backgroundColor: "#FFFFFF", borderRadius: 18, paddingHorizontal: 12, paddingVertical: 9, elevation: 3 },
  locationRetryText: { color: "#174A72", fontSize: 10, fontWeight: "800" },
  customerMap: { width: "100%", height: "100%", backgroundColor: "#E9F0F5" },
  customerMapLoadingOverlay: { ...StyleSheet.absoluteFill, zIndex: 10, elevation: 10, backgroundColor: "#E9F0F5", alignItems: "center", justifyContent: "center", gap: 8 },
  customerMapLoadingText: { color: "#526779", fontSize: 11, fontWeight: "700" },
  mapBrandPill: { position: "absolute", top: 13, left: 13, backgroundColor: "#FFFFFF", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8, shadowColor: "#102A43", shadowOpacity: 0.12, shadowRadius: 8, elevation: 3 },
  mapBrandText: { color: "#174A72", fontSize: 10, fontWeight: "900", letterSpacing: 1.2 },
  mapHintPill: { position: "absolute", bottom: 13, left: 13, right: 13, backgroundColor: "rgba(255,255,255,0.94)", borderRadius: 12, paddingHorizontal: 13, paddingVertical: 10 },
  mapHintText: { color: "#344054", fontSize: 11, fontWeight: "600", textAlign: "center" },
  serviceHeading: { marginBottom: 10 },
  serviceHeadingTitle: { color: "#142B3D", fontSize: 18, fontWeight: "900" },
  serviceHeadingSubtitle: { color: "#8793A2", fontSize: 11, marginTop: 4 },
  serviceChoices: { flexDirection: "row", gap: 9, marginBottom: 13 },
  serviceTile: { flex: 1, minHeight: 108, borderRadius: 15, padding: 12, borderWidth: 1, position: "relative" },
  serviceTileActive: { backgroundColor: "#F0F7FC", borderColor: "#8DBBD8" },
  serviceTileUpcoming: { backgroundColor: "#FFFFFF", borderColor: "#E5EAF0" },
  serviceEmoji: { fontSize: 21, marginBottom: 6 },
  serviceTitle: { color: "#182230", fontSize: 13, fontWeight: "900" },
  serviceDescription: { color: "#667085", fontSize: 10, marginTop: 4 },
  comingSoon: { color: "#236B9A", fontSize: 8, fontWeight: "900", letterSpacing: 0.8, marginTop: 8 },
  heroCard: { backgroundColor: "#174A72", borderRadius: 20, padding: 20, marginBottom: 18 },
  heroEyebrow: { color: "#BDD7EA", fontSize: 10, fontWeight: "800", letterSpacing: 1.4 },
  heroTitle: { color: "#FFFFFF", fontSize: 23, fontWeight: "800", marginTop: 8 },
  heroText: { color: "#DCEAF4", fontSize: 12, lineHeight: 19, marginTop: 7 },
  activityIntro: { color: "#667085", fontSize: 11, lineHeight: 17, marginTop: -3, marginBottom: 12 },
  activitySummaryRow: { flexDirection: "row", gap: 10, marginBottom: 14 },
  activitySummaryCard: { flex: 1, backgroundColor: "#F0F7FC", borderRadius: 12, borderWidth: 1, borderColor: "#DCEAF4", padding: 12 },
  activitySummaryValue: { color: "#174A72", fontSize: 21, fontWeight: "900" },
  activitySummaryLabel: { color: "#667085", fontSize: 10, fontWeight: "700", marginTop: 3 },
  tabRow: { flexDirection: "row", backgroundColor: "#E8EEF4", borderRadius: 13, padding: 4, marginBottom: 15 },
  tabButton: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 10 },
  tabButtonSelected: { backgroundColor: "#FFFFFF" },
  tabText: { color: "#667085", fontSize: 12, fontWeight: "700" },
  tabTextSelected: { color: "#174A72" },
  card: { backgroundColor: "#FFFFFF", borderRadius: 16, padding: 15, borderWidth: 1, borderColor: "#E5EAF0", marginBottom: 15 },
  cardTitle: { color: "#182230", fontSize: 17, fontWeight: "800", marginBottom: 5 },
  label: { color: "#344054", fontSize: 12, fontWeight: "700", marginBottom: 7, marginTop: 10 },
  addressInput: { minHeight: 50, borderWidth: 1, borderColor: "#DCE3EB", borderRadius: 12, paddingHorizontal: 13, color: "#182230", backgroundColor: "#FBFCFE", fontSize: 14 },
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
  adminFilterRow: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 10, marginBottom: 12 },
  adminFilterChip: { borderWidth: 1, borderColor: "#DCE3EB", borderRadius: 20, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: "#FFFFFF" },
  adminFilterChipSelected: { backgroundColor: "#174A72", borderColor: "#174A72" },
  adminFilterText: { color: "#667085", fontSize: 9, fontWeight: "800" },
  adminFilterTextSelected: { color: "#FFFFFF" },
  adminStatusText: { color: "#236B9A", fontSize: 9, fontWeight: "900", letterSpacing: 0.5 },
  adminInfoPanel: { backgroundColor: "#F7F9FB", borderRadius: 10, padding: 10, marginTop: 10 },
  adminActionRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 },
  adminApproveButton: { flex: 1, minWidth: 90, minHeight: 40, borderRadius: 10, backgroundColor: "#EAF7F0", borderWidth: 1, borderColor: "#B9E4CB", alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  adminApproveText: { color: "#067647", fontSize: 11, fontWeight: "800" },
  adminSecondaryButton: { flex: 1, minWidth: 85, minHeight: 40, borderRadius: 10, backgroundColor: "#F5F7FA", borderWidth: 1, borderColor: "#DCE3EB", alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  adminSecondaryText: { color: "#344054", fontSize: 11, fontWeight: "800" },
  trackingMapFrame: { height: 220, borderRadius: 13, overflow: "hidden", marginTop: 8, borderWidth: 1, borderColor: "#DCE3EB" },
  trackingPanel: { backgroundColor: "#F7FAFC", borderRadius: 13, padding: 12, marginTop: 12, borderWidth: 1, borderColor: "#E0E8EF" },
  trackingControlPanel: { backgroundColor: "#F7FAFC", borderRadius: 12, padding: 11, marginTop: 12, borderWidth: 1, borderColor: "#E0E8EF" },
  trackingStatusText: { color: "#174A72", fontSize: 11, fontWeight: "700", marginTop: 8 },
  trackingPrivacyText: { color: "#667085", fontSize: 10, lineHeight: 15, marginTop: 5 },
  routeMap: { width: "100%", height: "100%" },
  progressPanel: { backgroundColor: "#F7F9FB", borderRadius: 12, padding: 12, marginTop: 12, marginBottom: 10 },
  progressRow: { flexDirection: "row", alignItems: "center", gap: 9, marginTop: 9 },
  progressDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: "#D0D7DE" },
  progressDotDone: { backgroundColor: "#21865B" },
  progressText: { color: "#8793A2", fontSize: 11 },
  progressTextDone: { color: "#174A72", fontWeight: "800" },
  historyNotes: { backgroundColor: "#F7F9FB", borderRadius: 10, padding: 10, marginTop: 9 },
  codeEntryPanel: { backgroundColor: "#F0F7FC", borderRadius: 12, padding: 12, marginTop: 12, borderWidth: 1, borderColor: "#D3E6F3" },
  codePanel: { backgroundColor: "#F0F7FC", borderRadius: 13, padding: 14, marginTop: 14, marginBottom: 10, borderWidth: 1, borderColor: "#D3E6F3" },
  codeHeading: { color: "#174A72", fontSize: 14, fontWeight: "900", marginTop: 7, marginBottom: 5 },
  codeValue: { color: "#142B3D", fontSize: 25, fontWeight: "900", letterSpacing: 5, backgroundColor: "#FFFFFF", padding: 12, borderRadius: 10, marginTop: 5, overflow: "hidden" },
  quoteCard: { backgroundColor: "#F0F7FC", borderWidth: 1, borderColor: "#D3E6F3", borderRadius: 13, padding: 14, marginTop: 6, marginBottom: 13 },
  quoteDivider: { height: 1, backgroundColor: "#D3E6F3", marginVertical: 10 },
  quoteMetricRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 7, gap: 12 },
  quoteMetricLabel: { color: "#667085", fontSize: 11, flex: 1 },
  quoteMetricValue: { color: "#344054", fontSize: 11, fontWeight: "800", textAlign: "right" },
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

type AppStyles = typeof baseStyles;
let styles: AppStyles = baseStyles;

function appThemeColor(color: string, property: string, appearance: UiAppearance): string {
  if (appearance !== "DARK") return color;

  if (property === "backgroundColor") {
    const backgrounds: Record<string, string> = {
      "#FFFFFF": "#152638",
      "#F3F6FA": "#0B1521",
      "#FBFCFE": "#102031",
      "#F0F3F7": "#1A2B3D",
      "#F7FAFC": "#1A2B3D",
      "#F0F7FC": "#183349",
      "#EAF3F9": "#20394F",
      "#FFF4E5": "#47331E",
      "#FEF3F2": "#482525",
      "#E9F0F5": "#1A2C3D",
      "#E1E8EF": "#32475B"
    };
    return backgrounds[color.toUpperCase()] ?? color;
  }

  if (property === "borderColor" || property === "borderTopColor" || property === "borderBottomColor") {
    const borders: Record<string, string> = {
      "#E5EAF0": "#304456",
      "#E6EBF1": "#304456",
      "#E8EDF2": "#304456",
      "#F0F2F5": "#304456",
      "#DCE3EB": "#3A5065",
      "#E0E6ED": "#3A5065",
      "#E1E8EF": "#3A5065",
      "#D5DFE8": "#3A5065",
      "#D3E6F3": "#31516B",
      "#F2C7C4": "#6B4141"
    };
    return borders[color.toUpperCase()] ?? color;
  }

  if (property === "color") {
    const textColors: Record<string, string> = {
      "#142B3D": "#EAF2F8",
      "#182230": "#EAF2F8",
      "#243B4D": "#EAF2F8",
      "#344054": "#D5E1EC",
      "#667085": "#AABACB",
      "#8793A2": "#9AACC0",
      "#98A2B3": "#9AACC0",
      "#526779": "#C1D1DF",
      "#174A72": "#77BCE8",
      "#236B9A": "#7FC5ED",
      "#B42318": "#FCA5A5",
      "#067647": "#6EE7B7",
      "#93370D": "#FDBA8C"
    };
    return textColors[color.toUpperCase()] ?? color;
  }

  if (property === "shadowColor") return "#000000";
  return color;
}

function createAppStyles(appearance: UiAppearance, textSize: UiTextSize): AppStyles {
  const scale = textSize === "COMPACT" ? 0.92 : textSize === "LARGE" ? 1.16 : 1;
  const themed: Record<string, Record<string, unknown>> = {};

  for (const [name, baseStyle] of Object.entries(baseStyles)) {
    const nextStyle: Record<string, unknown> = { ...baseStyle };
    for (const [property, value] of Object.entries(nextStyle)) {
      if ((property === "fontSize" || property === "lineHeight") && typeof value === "number") {
        nextStyle[property] = Math.max(9, Math.round(value * scale));
      } else if (typeof value === "string" && /^#[0-9A-F]{6}$/i.test(value)) {
        nextStyle[property] = appThemeColor(value, property, appearance);
      }
    }
    themed[name] = nextStyle;
  }

  return StyleSheet.create(themed as never) as AppStyles;
}
