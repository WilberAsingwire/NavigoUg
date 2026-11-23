import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { StatusBar } from "expo-status-bar";
import * as SecureStore from "expo-secure-store";
import RidesHome from "./RidesHome";
import { SplashScreen, WelcomeScreen } from "./LaunchScreens";
import { BRAND_COLORS } from "./brand";
import { InteractiveTouchable as TouchableOpacity } from "./InteractiveTouchable";

const API_BASE_URL = "https://navigou-api-2978.onrender.com";
const SESSION_KEY = "navigo.session";

type UserRole = "CUSTOMER" | "RIDER" | "ADMIN";
type RiderApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "SUSPENDED" | null;

type User = {
  id: string;
  fullName: string;
  phone: string;
  email?: string | null;
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
    const message = (payload as ApiErrorBody | null)?.error?.message;
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
  const [showPassword, setShowPassword] = useState(false);
  const [licenceNumber, setLicenceNumber] = useState("");
  const [motorcyclePlate, setMotorcyclePlate] = useState("");
  const [motorcycleDescription, setMotorcycleDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [splashComplete, setSplashComplete] = useState(false);
  const [showWelcome, setShowWelcome] = useState(true);
  const [error, setError] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const authFade = useRef(new Animated.Value(1)).current;
  const authOffset = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (session || showWelcome || restoring || !splashComplete) return;

    authFade.setValue(0);
    authOffset.setValue(10);
    const entrance = Animated.parallel([
      Animated.timing(authFade, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true
      }),
      Animated.spring(authOffset, {
        toValue: 0,
        speed: 25,
        bounciness: 2,
        useNativeDriver: true
      })
    ]);
    entrance.start();
    return () => entrance.stop();
  }, [session, showWelcome, restoring, splashComplete, mode, role, authFade, authOffset]);


  useEffect(() => {
    const timer = setTimeout(() => setSplashComplete(true), 1_500);
    return () => clearTimeout(timer);
  }, []);

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

  function explainPasswordRecovery() {
    Alert.alert(
      "Password recovery",
      "Secure password recovery is not connected yet. It needs a verified phone or email delivery service. For now, please sign in with your existing password."
    );
  }

  function explainGoogleSignIn() {
    Alert.alert(
      "Google sign-in",
      "Google sign-in is not connected yet. It needs Google OAuth configuration and server-side token verification. You can currently sign in with your phone number and password."
    );
  }

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
      setShowWelcome(true);
      setBusy(false);
    }
  }

  if (restoring || !splashComplete) {
    return <SplashScreen />;
  }

  if (session) {
    return (
      <RidesHome
        session={session}
        onSignOut={signOut}
        onSessionChange={setSession}
        signingOut={busy}
      />
    );
  }

  if (showWelcome) {
    return (
      <WelcomeScreen
        onGetStarted={() => {
          setMode("login");
          setError("");
          setShowWelcome(false);
        }}
        onCreateAccount={() => {
          setMode("register");
          setError("");
          setShowWelcome(false);
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Animated.View style={{ flex: 1, opacity: authFade, transform: [{ translateY: authOffset }] }}>
        <ScrollView
          contentContainerStyle={styles.authPage}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.entryBackButton}
            onPress={() => { setShowWelcome(true); setError(""); }}
          >
            <Text style={styles.entryBackText}>←  Back to welcome</Text>
          </TouchableOpacity>
          <Brand />
          <View style={styles.headingBlock}>
            <Text style={styles.eyebrow}>WELCOME TO NAVIGO</Text>
            <Text style={styles.heading}>
              {mode === "login" ? "Move with confidence." : "Let's get you started."}
            </Text>
            <Text style={styles.subheading}>
              {mode === "login"
                ? "Sign in to book a motorcycle ride or send a ready parcel."
                : "Create an account for convenient rides and ready-parcel delivery."}
            </Text>
          </View>

          <View style={styles.authCard}>
            <View style={styles.modeSwitch}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: mode === "login" }}
                style={[styles.modeOption, mode === "login" && styles.modeOptionActive]}
                onPress={() => { setMode("login"); setError(""); setShowPassword(false); }}
              >
                <Text style={[styles.modeText, mode === "login" && styles.modeTextActive]}>Sign in</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: mode === "register" }}
                style={[styles.modeOption, mode === "register" && styles.modeOptionActive]}
                onPress={() => { setMode("register"); setError(""); setShowPassword(false); }}
              >
                <Text style={[styles.modeText, mode === "register" && styles.modeTextActive]}>Create account</Text>
              </TouchableOpacity>
            </View>

            {mode === "register" && (
              <>
                <Text style={styles.fieldLabel}>I want to join as</Text>
                <View style={styles.roleSwitch}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityState={{ selected: role === "CUSTOMER" }}
                    style={[styles.roleOption, role === "CUSTOMER" && styles.roleOptionActive]}
                    onPress={() => { setRole("CUSTOMER"); setError(""); }}
                  >
                    <Text style={[styles.roleText, role === "CUSTOMER" && styles.roleTextActive]}>Customer</Text>
                    <Text style={styles.roleHint}>Book rides and send parcels</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityState={{ selected: role === "RIDER" }}
                    style={[styles.roleOption, role === "RIDER" && styles.roleOptionActive]}
                    onPress={() => { setRole("RIDER"); setError(""); }}
                  >
                    <Text style={[styles.roleText, role === "RIDER" && styles.roleTextActive]}>Rider</Text>
                    <Text style={styles.roleHint}>Receive ride and parcel jobs</Text>
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
                label="Email address (optional)"
                value={email}
                onChangeText={setEmail}
                placeholder="name@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
              />
            )}

            {mode === "register" && role === "RIDER" && (
              <View style={styles.riderSection}>
                <Text style={styles.sectionLabel}>Rider and motorcycle details</Text>
                <Field label="Driving licence number" value={licenceNumber} onChangeText={setLicenceNumber} placeholder="Enter licence number" />
                <Field label="Motorcycle number plate" value={motorcyclePlate} onChangeText={setMotorcyclePlate} placeholder="e.g. UXX 123X" autoCapitalize="characters" />
                <Field label="Motorcycle description" value={motorcycleDescription} onChangeText={setMotorcycleDescription} placeholder="Make, model and colour" />
                <Text style={styles.helperText}>Rider accounts require administrator approval before accepting bookings.</Text>
              </View>
            )}

            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder="At least 8 characters"
              secureTextEntry={!showPassword}
              onToggleSecure={() => setShowPassword((visible) => !visible)}
              autoCapitalize="none"
            />

            {mode === "login" && (
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.forgotButton}
                onPress={explainPasswordRecovery}
              >
                <Text style={styles.forgotText}>Forgot password?</Text>
              </TouchableOpacity>
            )}

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

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR CONTINUE WITH</Text>
              <View style={styles.dividerLine} />
            </View>

            <TouchableOpacity
              accessibilityRole="button"
              style={styles.googleButton}
              onPress={explainGoogleSignIn}
            >
              <View style={styles.googleMark}>
                <Text style={styles.googleLetter}>G</Text>
              </View>
              <Text style={styles.googleButtonText}>Continue with Google</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.legalText}>
            A simpler way to move around Arua and send parcels with confidence.
          </Text>
          <Text style={styles.footer}>Arua, Uganda</Text>
        </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Brand() {
  return (
    <View style={styles.brand}>
      <Image source={require("./assets/icon.png")} style={styles.brandLogo} resizeMode="contain" accessibilityLabel="NAVIGO logo" />
      <Text style={styles.brandName}>NAVIGO</Text>
      <Text style={styles.brandTagline}>Your journey, made easier.</Text>
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
  onToggleSecure?: () => void;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) {
  const isPassword = typeof props.onToggleSecure === "function";

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{props.label}</Text>
      <View style={styles.inputShell}>
        <TextInput
          style={[styles.input, isPassword && styles.inputWithAccessory]}
          value={props.value}
          onChangeText={props.onChangeText}
          placeholder={props.placeholder}
          placeholderTextColor="#98A2B3"
          keyboardType={props.keyboardType ?? "default"}
          secureTextEntry={props.secureTextEntry}
          autoCapitalize={props.autoCapitalize ?? "sentences"}
          autoCorrect={false}
        />
        {isPassword && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={props.secureTextEntry ? "Show password" : "Hide password"}
            accessibilityHint="Toggles password visibility"
            style={styles.eyeButton}
            onPress={props.onToggleSecure}
          >
            <View style={styles.eyeShape}>
              <View style={styles.eyePupil} />
            </View>
          </TouchableOpacity>
        )}
      </View>
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
  safeArea: { flex: 1, backgroundColor: "#F3F6FA" },
  flex: { flex: 1 },
  authPage: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 28 },
  entryBackButton: { alignSelf: "flex-start", paddingVertical: 8, paddingHorizontal: 3, marginBottom: 5 },
  entryBackText: { color: BRAND_COLORS.blue, fontSize: 12, fontWeight: "700" },
  dashboard: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 34, paddingBottom: 30 },
  brand: { alignItems: "center", marginBottom: 25 },
  brandLogo: { width: 68, height: 68, borderRadius: 18, backgroundColor: "#EDF4FF", marginBottom: 9, shadowColor: BRAND_COLORS.navy, shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.14, shadowRadius: 9, elevation: 4 },
  brandName: { color: BRAND_COLORS.navy, fontSize: 25, fontWeight: "900", letterSpacing: 2.4 },
  brandTagline: { color: "#667085", fontSize: 12, marginTop: 4, letterSpacing: 0.2 },
  headingBlock: { marginBottom: 19, paddingHorizontal: 3 },
  eyebrow: { color: BRAND_COLORS.blue, fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 8 },
  heading: { color: "#142B3D", fontSize: 27, lineHeight: 33, fontWeight: "800" },
  subheading: { color: "#667085", fontSize: 13, lineHeight: 20, marginTop: 7 },
  authCard: {
    backgroundColor: "#FFFFFF", borderRadius: 22, padding: 18,
    borderWidth: 1, borderColor: "#E6EBF1",
    shadowColor: "#142B3D", shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06, shadowRadius: 18, elevation: 3
  },
  modeSwitch: { flexDirection: "row", backgroundColor: "#F0F3F7", padding: 4, borderRadius: 13, marginBottom: 19 },
  modeOption: { flex: 1, alignItems: "center", paddingVertical: 11, borderRadius: 10 },
  modeOptionActive: { backgroundColor: "#FFFFFF", shadowColor: "#142B3D", shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 3, elevation: 1 },
  modeText: { color: "#667085", fontWeight: "600", fontSize: 13 },
  modeTextActive: { color: BRAND_COLORS.navy, fontWeight: "800" },
  roleSwitch: { flexDirection: "row", gap: 10, marginTop: 7, marginBottom: 16 },
  roleOption: {
    flex: 1, borderWidth: 1, borderColor: "#E0E6ED", borderRadius: 13,
    paddingVertical: 12, paddingHorizontal: 8, alignItems: "center", backgroundColor: "#FFFFFF"
  },
  roleOptionActive: { borderColor: BRAND_COLORS.blue, backgroundColor: "#F0F7FC" },
  roleText: { color: "#667085", fontWeight: "700", fontSize: 13 },
  roleTextActive: { color: BRAND_COLORS.navy },
  roleHint: { color: "#8793A2", fontSize: 10, textAlign: "center", marginTop: 4 },
  field: { marginBottom: 14 },
  fieldLabel: { color: "#344054", fontSize: 12, fontWeight: "700", marginBottom: 7 },
  inputShell: {
    minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: "#DCE3EB",
    backgroundColor: "#FBFCFE", flexDirection: "row", alignItems: "center"
  },
  input: { flex: 1, minHeight: 48, paddingHorizontal: 14, paddingVertical: 11, color: "#182230", fontSize: 14 },
  inputWithAccessory: { paddingRight: 4 },
  eyeButton: { width: 46, height: 48, alignItems: "center", justifyContent: "center" },
  eyeShape: {
    width: 19, height: 13, borderWidth: 1.5, borderColor: "#667085",
    borderRadius: 10, alignItems: "center", justifyContent: "center"
  },
  eyePupil: { width: 5, height: 5, borderRadius: 3, backgroundColor: "#667085" },
  forgotButton: { alignSelf: "flex-end", marginTop: -4, marginBottom: 13, paddingVertical: 4, paddingLeft: 10 },
  forgotText: { color: BRAND_COLORS.blue, fontSize: 12, fontWeight: "700" },
  riderSection: { backgroundColor: "#F7FAFC", borderRadius: 14, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: "#E8EEF4" },
  sectionLabel: { color: BRAND_COLORS.navy, fontWeight: "800", fontSize: 13, marginBottom: 12 },
  helperText: { color: "#667085", fontSize: 11, lineHeight: 17, marginTop: 0 },
  errorBox: { backgroundColor: "#FEF3F2", borderRadius: 10, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: "#FEE4E2" },
  errorText: { color: "#B42318", fontSize: 12, lineHeight: 18 },
  primaryButton: {
    minHeight: 52, backgroundColor: BRAND_COLORS.navy, borderRadius: 13,
    alignItems: "center", justifyContent: "center", marginTop: 3,
    shadowColor: BRAND_COLORS.navy, shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.16, shadowRadius: 8, elevation: 3
  },
  primaryButtonText: { color: "#FFFFFF", fontWeight: "800", fontSize: 14, letterSpacing: 0.2 },
  dividerRow: { flexDirection: "row", alignItems: "center", marginVertical: 18, gap: 10 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#E8EDF2" },
  dividerText: { color: "#98A2B3", fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  googleButton: {
    minHeight: 49, borderWidth: 1, borderColor: "#DCE3EB", borderRadius: 12,
    backgroundColor: "#FFFFFF", flexDirection: "row", alignItems: "center", justifyContent: "center"
  },
  googleMark: { width: 23, height: 23, borderRadius: 12, borderWidth: 1, borderColor: "#E4E7EC", alignItems: "center", justifyContent: "center", marginRight: 10 },
  googleLetter: { color: "#4285F4", fontSize: 15, fontWeight: "900" },
  googleButtonText: { color: "#344054", fontSize: 13, fontWeight: "700" },
  legalText: { color: "#98A2B3", fontSize: 10, lineHeight: 15, textAlign: "center", marginTop: 17, paddingHorizontal: 8 },
  secondaryButton: {
    minHeight: 50, borderWidth: 1, borderColor: BRAND_COLORS.navy, borderRadius: 13,
    backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", marginTop: 22
  },
  secondaryButtonText: { color: BRAND_COLORS.navy, fontWeight: "700", fontSize: 14 },
  buttonDisabled: { opacity: 0.65 },
  welcomeCard: { backgroundColor: "#FFFFFF", borderRadius: 18, padding: 21, borderWidth: 1, borderColor: "#E5EAF0", marginBottom: 16 },
  welcomeTitle: { color: "#182230", fontSize: 26, fontWeight: "800", marginTop: 2 },
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
  footer: { color: "#98A2B3", fontSize: 11, textAlign: "center", marginTop: 22 }
});
