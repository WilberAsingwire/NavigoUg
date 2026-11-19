import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
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
import * as SecureStore from "expo-secure-store";

const API_BASE_URL = "https://navigou-api-2978.onrender.com";
const SESSION_KEY = "navigo.session";

type UserRole = "CUSTOMER" | "RIDER" | "ADMIN";
type RiderApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED" | null;

type User = {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  role: UserRole;
  riderApprovalStatus: RiderApprovalStatus;
};

type Session = {
  accessToken: string;
  refreshToken: string;
  tokenType: "Bearer";
  expiresIn: number;
  user: User;
};

type ApiErrorBody = { error?: { message?: string } };

async function apiRequest<T>(
  path: string,
  init: Parameters<typeof fetch>[1] = {}
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => null) as T | ApiErrorBody | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? payload.error?.message
        : undefined;
    throw new Error(message || "Something went wrong. Please try again.");
  }

  return payload as T;
}

export default function App() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [role, setRole] = useState<"CUSTOMER" | "RIDER">("CUSTOMER");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [licenceNumber, setLicenceNumber] = useState("");
  const [motorcyclePlate, setMotorcyclePlate] = useState("");
  const [motorcycleDescription, setMotorcycleDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [error, setError] = useState("");
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let mounted = true;

    SecureStore.getItemAsync(SESSION_KEY)
      .then((stored) => {
        if (!mounted || !stored) return;
        try {
          const saved = JSON.parse(stored) as Session;
          if (saved.accessToken && saved.refreshToken && saved.user) {
            setSession(saved);
          } else {
            void SecureStore.deleteItemAsync(SESSION_KEY);
          }
        } catch {
          void SecureStore.deleteItemAsync(SESSION_KEY);
        }
      })
      .catch(() => {
        if (mounted) setError("Unable to restore your saved session.");
      })
      .finally(() => {
        if (mounted) setRestoring(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  async function submitAuth() {
    setError("");

    if (!phone.trim() || !password) {
      setError("Enter your phone number and password.");
      return;
    }
    if (mode === "register" && !fullName.trim()) {
      setError("Enter your full name.");
      return;
    }
    if (password.length < 8) {
      setError("Your password must contain at least 8 characters.");
      return;
    }
    if (
      mode === "register" &&
      role === "RIDER" &&
      (!licenceNumber.trim() || !motorcyclePlate.trim() || !motorcycleDescription.trim())
    ) {
      setError("Complete all motorcycle and licence details.");
      return;
    }

    setBusy(true);
    try {
      const path =
        mode === "login"
          ? "/api/v1/auth/login"
          : role === "RIDER"
            ? "/api/v1/auth/register/rider"
            : "/api/v1/auth/register/customer";

      const body =
        mode === "login"
          ? { phone: phone.trim(), password }
          : {
              fullName: fullName.trim(),
              phone: phone.trim(),
              ...(email.trim() ? { email: email.trim() } : {}),
              password,
              ...(role === "RIDER"
                ? {
                    licenceNumber: licenceNumber.trim(),
                    motorcyclePlate: motorcyclePlate.trim(),
                    motorcycleDescription: motorcycleDescription.trim()
                  }
                : {})
            };

      const result = await apiRequest<{ data: Session }>(path, {
        method: "POST",
        body: JSON.stringify(body)
      });

      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(result.data));
      setSession(result.data);
      setPassword("");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Unable to complete your request. Please try again."
      );
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!session) return;
    setBusy(true);
    try {
      await apiRequest<void>("/api/v1/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ refreshToken: session.refreshToken })
      });
    } catch {
      // Clear the device session even when the network is unavailable.
    } finally {
      await SecureStore.deleteItemAsync(SESSION_KEY).catch(() => undefined);
      setSession(null);
      setMode("login");
      setRole("CUSTOMER");
      setBusy(false);
    }
  }

  if (restoring) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#174A72" />
          <Text style={styles.muted}>Preparing NAVIGO...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (session) {
    const riderPending =
      session.user.role === "RIDER" && session.user.riderApprovalStatus === "PENDING";

    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.dashboard}>
          <Brand />
          <View style={styles.welcomeCard}>
            <Text style={styles.eyebrow}>YOUR NAVIGO ACCOUNT</Text>
            <Text style={styles.welcomeTitle}>Hello, {session.user.fullName.split(" ")[0]}.</Text>
            <Text style={styles.bodyText}>
              {session.user.role === "RIDER"
                ? riderPending
                  ? "Your rider application has been received. An administrator must approve your account before you can accept bookings."
                  : session.user.riderApprovalStatus === "APPROVED"
                    ? "Your rider account is approved. Rider booking tools will appear here as the next features are added."
                    : "Your rider account is not currently approved. Please contact the NAVIGO administrator for assistance."
                : "Your account is ready. Motorcycle ride booking and ready-parcel services are being added to NAVIGO."}
            </Text>
            {session.user.role === "RIDER" && (
              <View style={styles.statusPill}>
                <Text style={styles.statusText}>
                  RIDER STATUS: {session.user.riderApprovalStatus ?? "NOT SET"}
                </Text>
              </View>
            )}
          </View>
          <View style={styles.infoCard}>
            <Text style={styles.infoTitle}>Account details</Text>
            <Detail label="Name" value={session.user.fullName} />
            <Detail label="Phone" value={session.user.phone} />
            <Detail label="Account type" value={session.user.role} />
          </View>
          <TouchableOpacity
            accessibilityRole="button"
            style={[styles.secondaryButton, busy && styles.buttonDisabled]}
            onPress={signOut}
            disabled={busy}
          >
            {busy ? <ActivityIndicator color="#174A72" /> : <Text style={styles.secondaryButtonText}>Sign out</Text>}
          </TouchableOpacity>
          <Text style={styles.footer}>Muni University • Arua, Uganda</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.authPage}
          keyboardShouldPersistTaps="handled"
        >
          <Brand />
          <View style={styles.headingBlock}>
            <Text style={styles.heading}>
              {mode === "login" ? "Welcome back" : "Create your account"}
            </Text>
            <Text style={styles.subheading}>
              {mode === "login"
                ? "Sign in to continue with NAVIGO."
                : "Join NAVIGO for motorcycle rides and ready-parcel delivery."}
            </Text>
          </View>

          <View style={styles.modeSwitch}>
            <TouchableOpacity
              style={[styles.modeOption, mode === "login" && styles.modeOptionActive]}
              onPress={() => { setMode("login"); setError(""); }}
            >
              <Text style={[styles.modeText, mode === "login" && styles.modeTextActive]}>Sign in</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeOption, mode === "register" && styles.modeOptionActive]}
              onPress={() => { setMode("register"); setError(""); }}
            >
              <Text style={[styles.modeText, mode === "register" && styles.modeTextActive]}>Create account</Text>
            </TouchableOpacity>
          </View>

          {mode === "register" && (
            <>
              <Text style={styles.fieldLabel}>I want to join as</Text>
              <View style={styles.roleSwitch}>
                <TouchableOpacity
                  style={[styles.roleOption, role === "CUSTOMER" && styles.roleOptionActive]}
                  onPress={() => { setRole("CUSTOMER"); setError(""); }}
                >
                  <Text style={[styles.roleText, role === "CUSTOMER" && styles.roleTextActive]}>Customer</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.roleOption, role === "RIDER" && styles.roleOptionActive]}
                  onPress={() => { setRole("RIDER"); setError(""); }}
                >
                  <Text style={[styles.roleText, role === "RIDER" && styles.roleTextActive]}>Rider</Text>
                </TouchableOpacity>
              </View>
              <Field label="Full name" value={fullName} onChangeText={setFullName} placeholder="Enter your full name" />
            </>
          )}

          <Field
            label="Phone number"
            value={phone}
            onChangeText={setPhone}
            placeholder="+256 7XX XXX XXX"
            keyboardType="phone-pad"
          />

          {mode === "register" && (
            <Field
              label="Email (optional)"
              value={email}
              onChangeText={setEmail}
              placeholder="name@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
            />
          )}

          {mode === "register" && role === "RIDER" && (
            <>
              <Text style={styles.sectionLabel}>Rider details</Text>
              <Field label="Driving licence number" value={licenceNumber} onChangeText={setLicenceNumber} placeholder="Enter licence number" />
              <Field label="Motorcycle number plate" value={motorcyclePlate} onChangeText={setMotorcyclePlate} placeholder="e.g. UXX 123X" autoCapitalize="characters" />
              <Field label="Motorcycle description" value={motorcycleDescription} onChangeText={setMotorcycleDescription} placeholder="Make, model and colour" />
              <Text style={styles.helperText}>Rider accounts require administrator approval before accepting bookings.</Text>
            </>
          )}

          <Field
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="At least 8 characters"
            secureTextEntry
            autoCapitalize="none"
          />

          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          ) : null}

          <TouchableOpacity
            accessibilityRole="button"
            style={[styles.primaryButton, busy && styles.buttonDisabled]}
            onPress={submitAuth}
            disabled={busy}
          >
            {busy ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryButtonText}>
                {mode === "login" ? "Sign in" : role === "RIDER" ? "Submit rider application" : "Create account"}
              </Text>
            )}
          </TouchableOpacity>

          <Text style={styles.footer}>Muni University • Arua, Uganda</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Brand() {
  return (
    <View style={styles.brand}>
      <View style={styles.brandMark}>
        <Text style={styles.brandLetter}>N</Text>
      </View>
      <Text style={styles.brandName}>NAVIGO</Text>
      <Text style={styles.brandTagline}>Your ride. Your parcel. Connected.</Text>
    </View>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  keyboardType?: "default" | "email-address" | "phone-pad";
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <TextInput
        style={styles.input}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor="#98A2B3"
        keyboardType={props.keyboardType ?? "default"}
        secureTextEntry={props.secureTextEntry}
        autoCapitalize={props.autoCapitalize ?? "sentences"}
        autoCorrect={false}
      />
    </View>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F4F7FB" },
  flex: { flex: 1 },
  authPage: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 30 },
  dashboard: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 34, paddingBottom: 30 },
  brand: { alignItems: "center", marginBottom: 28 },
  brandMark: {
    width: 58, height: 58, borderRadius: 18, backgroundColor: "#174A72",
    alignItems: "center", justifyContent: "center", marginBottom: 9
  },
  brandLetter: { color: "#FFFFFF", fontSize: 31, fontWeight: "800" },
  brandName: { color: "#174A72", fontSize: 25, fontWeight: "800", letterSpacing: 2 },
  brandTagline: { color: "#667085", fontSize: 12, marginTop: 4 },
  headingBlock: { marginBottom: 20 },
  heading: { color: "#182230", fontSize: 27, fontWeight: "800" },
  subheading: { color: "#667085", fontSize: 14, lineHeight: 21, marginTop: 6 },
  modeSwitch: {
    flexDirection: "row", backgroundColor: "#E9EEF5", padding: 4,
    borderRadius: 13, marginBottom: 20
  },
  modeOption: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 10 },
  modeOptionActive: { backgroundColor: "#FFFFFF" },
  modeText: { color: "#667085", fontWeight: "600", fontSize: 13 },
  modeTextActive: { color: "#174A72" },
  roleSwitch: { flexDirection: "row", gap: 10, marginTop: 7, marginBottom: 15 },
  roleOption: {
    flex: 1, borderWidth: 1, borderColor: "#D8E0EA", borderRadius: 12,
    paddingVertical: 12, alignItems: "center", backgroundColor: "#FFFFFF"
  },
  roleOptionActive: { borderColor: "#174A72", backgroundColor: "#EAF2F8" },
  roleText: { color: "#667085", fontWeight: "600" },
  roleTextActive: { color: "#174A72" },
  sectionLabel: { color: "#174A72", fontWeight: "700", fontSize: 14, marginTop: 2, marginBottom: 10 },
  field: { marginBottom: 14 },
  fieldLabel: { color: "#344054", fontSize: 13, fontWeight: "700", marginBottom: 7 },
  input: {
    minHeight: 49, borderRadius: 12, borderWidth: 1, borderColor: "#D8E0EA",
    backgroundColor: "#FFFFFF", paddingHorizontal: 14, color: "#182230", fontSize: 14
  },
  helperText: { color: "#667085", fontSize: 12, lineHeight: 18, marginTop: -4, marginBottom: 12 },
  errorBox: { backgroundColor: "#FEF3F2", borderRadius: 10, padding: 12, marginBottom: 14 },
  errorText: { color: "#B42318", fontSize: 13, lineHeight: 18 },
  primaryButton: {
    minHeight: 52, backgroundColor: "#174A72", borderRadius: 13,
    alignItems: "center", justifyContent: "center", marginTop: 6
  },
  primaryButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
  secondaryButton: {
    minHeight: 50, borderWidth: 1, borderColor: "#174A72", borderRadius: 13,
    backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", marginTop: 22
  },
  secondaryButtonText: { color: "#174A72", fontWeight: "700", fontSize: 14 },
  buttonDisabled: { opacity: 0.65 },
  welcomeCard: { backgroundColor: "#FFFFFF", borderRadius: 18, padding: 21, borderWidth: 1, borderColor: "#E5EAF0", marginBottom: 16 },
  eyebrow: { color: "#667085", fontSize: 10, fontWeight: "800", letterSpacing: 1.2 },
  welcomeTitle: { color: "#182230", fontSize: 26, fontWeight: "800", marginTop: 8 },
  bodyText: { color: "#667085", fontSize: 14, lineHeight: 22, marginTop: 10 },
  statusPill: { alignSelf: "flex-start", backgroundColor: "#FFF4E5", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 7, marginTop: 14 },
  statusText: { color: "#93370D", fontSize: 11, fontWeight: "800" },
  infoCard: { backgroundColor: "#FFFFFF", borderRadius: 16, padding: 18, borderWidth: 1, borderColor: "#E5EAF0" },
  infoTitle: { color: "#182230", fontSize: 16, fontWeight: "700", marginBottom: 13 },
  detailRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 9, borderTopWidth: 1, borderTopColor: "#F0F2F5" },
  detailLabel: { color: "#667085", fontSize: 13 },
  detailValue: { color: "#344054", fontSize: 13, fontWeight: "600", flexShrink: 1, marginLeft: 10 },
  loading: { flex: 1, justifyContent: "center", alignItems: "center", gap: 12 },
  muted: { color: "#667085", fontSize: 13 },
  footer: { color: "#98A2B3", fontSize: 11, textAlign: "center", marginTop: 28 }
});
