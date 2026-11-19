import { useCallback, useEffect, useState } from "react";
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
import * as Location from "expo-location";
import { StatusBar } from "expo-status-bar";

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

type Quote = {
  fareAmountUgx: number;
  distanceKm: number;
  fareBasis: "LANDMARK_FARE" | "DISTANCE_RULE";
};

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

async function apiRequest<T>(path: string, token: string, init: Parameters<typeof fetch>[1] = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {})
    }
  });
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

async function geocodeAruaAddress(value: string): Promise<RideLocation> {
  const trimmed = value.trim();
  if (trimmed.length < 3) throw new Error("Enter a pickup or destination address.");
  const query = /arua/i.test(trimmed) ? trimmed : `${trimmed}, Arua, Uganda`;
  const results = await Location.geocodeAsync(query);
  const firstResult = results[0];
  if (!firstResult) {
    throw new Error(`We couldn't locate "${trimmed}". Try adding a nearby landmark or a clearer Arua address.`);
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
  const [tab, setTab] = useState<"book" | "history">("book");
  const [pickup, setPickup] = useState("");
  const [destination, setDestination] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("CASH");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [locations, setLocations] = useState<{ pickup: RideLocation; destination: RideLocation } | null>(null);
  const [rides, setRides] = useState<Ride[]>([]);
  const [availableRides, setAvailableRides] = useState<Ride[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const mine = await apiRequest<{ data: Ride[] }>("/api/v1/rides/mine", session.accessToken);
      setRides(mine.data ?? []);
      if (isApprovedRider) {
        const available = await apiRequest<{ data: Ride[] }>("/api/v1/rides/available", session.accessToken);
        setAvailableRides(available.data ?? []);
      } else {
        setAvailableRides([]);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load your rides.");
    } finally {
      setLoading(false);
    }
  }, [session.accessToken, isApprovedRider]);

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
        geocodeAruaAddress(pickup),
        geocodeAruaAddress(destination)
      ]);
      const result = await apiRequest<{ data: Quote }>("/api/v1/rides/fare-quote", session.accessToken, {
        method: "POST",
        body: JSON.stringify({ pickup: pickupLocation, destination: destinationLocation })
      });
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
      await apiRequest<{ data: Ride }>("/api/v1/rides", session.accessToken, {
        method: "POST",
        body: JSON.stringify({ ...locations, paymentMethod })
      });
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
        await apiRequest(`/api/v1/rides/${rideId}/accept`, session.accessToken, { method: "POST" });
      } else if (action === "cancel") {
        await apiRequest(`/api/v1/rides/${rideId}/cancel`, session.accessToken, { method: "POST" });
      } else {
        await apiRequest(`/api/v1/rides/${rideId}/status`, session.accessToken, {
          method: "PATCH",
          body: JSON.stringify({ status: action })
        });
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
                  onChangeText={(value) => { setPickup(value); setQuote(null); setLocations(null); }}
                  placeholder="e.g. Arua Main Market"
                  placeholderTextColor="#98A2B3"
                />
                <Text style={styles.label}>Destination</Text>
                <TextInput
                  style={styles.addressInput}
                  value={destination}
                  onChangeText={(value) => { setDestination(value); setQuote(null); setLocations(null); }}
                  placeholder="e.g. Arua Hill"
                  placeholderTextColor="#98A2B3"
                />

                <Text style={styles.label}>Payment preference</Text>
                <View style={styles.paymentRow}>
                  <ChoiceButton label="Cash" selected={paymentMethod === "CASH"} onPress={() => setPaymentMethod("CASH")} />
                  <ChoiceButton label="Mobile Money" selected={paymentMethod === "MOBILE_MONEY"} onPress={() => setPaymentMethod("MOBILE_MONEY")} />
                </View>

                {quote && (
                  <View style={styles.quoteCard}>
                    <Text style={styles.quoteLabel}>ESTIMATED FARE</Text>
                    <Text style={styles.quoteAmount}>{money(quote.fareAmountUgx)}</Text>
                    <Text style={styles.quoteNote}>{quote.distanceKm.toFixed(2)} km straight-line distance estimate</Text>
                    <Text style={styles.quoteNote}>Final travel distance may be longer by road.</Text>
                  </View>
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
  paymentRow: { flexDirection: "row", gap: 9, marginTop: 2, marginBottom: 13 },
  choiceButton: { flex: 1, alignItems: "center", borderWidth: 1, borderColor: "#DCE3EB", borderRadius: 10, paddingVertical: 11, backgroundColor: "#FFFFFF" },
  choiceButtonSelected: { borderColor: "#2B719F", backgroundColor: "#F0F7FC" },
  choiceText: { color: "#667085", fontSize: 12, fontWeight: "700" },
  choiceTextSelected: { color: "#174A72" },
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
