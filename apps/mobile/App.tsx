import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Image,
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
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import Svg, { Circle, Defs, LinearGradient, Path, Rect, Stop } from "react-native-svg";
import RidesHome from "./RidesHome";

const API_BASE_URL = "https://navigou-api-2978.onrender.com";
const SESSION_KEY = "navigo.session";
const PUSH_TOKEN_KEY = "navigo.pushToken";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true
  })
});

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
  const [introComplete, setIntroComplete] = useState(false);
  const [error, setError] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [pushNotificationsEnabled, setPushNotificationsEnabled] = useState(false);
  const [pushNotificationsBusy, setPushNotificationsBusy] = useState(false);

  async function registerPushToken(currentSession: Session, pushToken: string) {
    await apiRequest<{ data: { registered: boolean } }>("/api/v1/notifications/device-token", {
      method: "POST",
      headers: { Authorization: "Bearer " + currentSession.accessToken },
      body: JSON.stringify({ pushToken, platform: "ANDROID" })
    });
    await SecureStore.setItemAsync(PUSH_TOKEN_KEY, pushToken);
    setPushNotificationsEnabled(true);
  }

  async function enablePushNotifications(): Promise<boolean> {
    if (!session || Platform.OS !== "android") return false;
    setPushNotificationsBusy(true);
    try {
      await Notifications.setNotificationChannelAsync("default", {
        name: "NAVIGO booking updates",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#174A72"
      });

      const currentPermission = await Notifications.getPermissionsAsync();
      const permission = currentPermission.granted
        ? currentPermission
        : await Notifications.requestPermissionsAsync();
      if (!permission.granted) {
        setPushNotificationsEnabled(false);
        Alert.alert(
          "Notifications are turned off",
          "Allow NAVIGO notifications in your Android settings to receive booking alerts. You can still review updates in the in-app inbox."
        );
        return false;
      }

      const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
      if (!projectId) {
        throw new Error("The NAVIGO EAS project ID is missing from this build.");
      }

      const tokenResult = await Notifications.getExpoPushTokenAsync({ projectId });
      await registerPushToken(session, tokenResult.data);
      Alert.alert("Push alerts enabled", "NAVIGO can now send booking updates to this Android device.");
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Push notifications could not be enabled.";
      Alert.alert("Could not enable push alerts", message);
      return false;
    } finally {
      setPushNotificationsBusy(false);
    }
  }

  async function disablePushNotifications(): Promise<boolean> {
    if (!session) return false;
    setPushNotificationsBusy(true);
    try {
      const savedToken = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
      if (savedToken) {
        await apiRequest("/api/v1/notifications/device-token", {
          method: "DELETE",
          headers: { Authorization: "Bearer " + session.accessToken },
          body: JSON.stringify({ pushToken: savedToken })
        });
      }
      await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
      setPushNotificationsEnabled(false);
      Alert.alert("Push alerts disabled", "NAVIGO will keep your in-app notification inbox available.");
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Push alerts could not be disabled.";
      Alert.alert("Could not disable push alerts", message);
      return false;
    } finally {
      setPushNotificationsBusy(false);
    }
  }

  useEffect(() => {
    let active = true;
    if (!session) {
      setPushNotificationsEnabled(false);
      return () => { active = false; };
    }

    void (async () => {
      const savedToken = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
      if (!savedToken || !active) return;

      const permission = await Notifications.getPermissionsAsync();
      if (!permission.granted || !active) {
        setPushNotificationsEnabled(false);
        if (active) {
          try {
            await apiRequest("/api/v1/notifications/device-token", {
              method: "DELETE",
              headers: { Authorization: "Bearer " + session.accessToken },
              body: JSON.stringify({ pushToken: savedToken })
            });
            await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
          } catch {
            // Keep the saved token so a later session can retry unregistration.
          }
        }
        return;
      }

      await Notifications.setNotificationChannelAsync("default", {
        name: "NAVIGO booking updates",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#174A72"
      });
      const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
      if (!projectId) return;

      const tokenResult = await Notifications.getExpoPushTokenAsync({ projectId });
      if (!active) return;
      const currentToken = tokenResult.data;
      if (currentToken !== savedToken) {
        try {
          await apiRequest("/api/v1/notifications/device-token", {
            method: "DELETE",
            headers: { Authorization: "Bearer " + session.accessToken },
            body: JSON.stringify({ pushToken: savedToken })
          });
        } catch {
          // The new token registration below remains authoritative for this device.
        }
      }
      await registerPushToken(session, currentToken);
    })().catch(() => {
      if (active) setPushNotificationsEnabled(false);
    });

    return () => { active = false; };
  }, [session?.user.id, session?.accessToken]);

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

  useEffect(() => {
    if (restoring) return;
    const timer = setTimeout(() => setIntroComplete(true), 2600);
    return () => clearTimeout(timer);
  }, [restoring]);

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
      const savedPushToken = await SecureStore.getItemAsync(PUSH_TOKEN_KEY).catch(() => null);
      if (savedPushToken) {
        await apiRequest("/api/v1/notifications/device-token", {
          method: "DELETE",
          headers: { Authorization: "Bearer " + session.accessToken },
          body: JSON.stringify({ pushToken: savedPushToken })
        }).catch(() => undefined);
      }
      await apiRequest<void>("/api/v1/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ refreshToken: session.refreshToken })
      });
    } catch {
      // Clear the device session even when the network is unavailable.
    } finally {
      await SecureStore.deleteItemAsync(SESSION_KEY).catch(() => undefined);
      await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY).catch(() => undefined);
      setPushNotificationsEnabled(false);
      setSession(null);
      setMode("login");
      setRole("CUSTOMER");
      setBusy(false);
    }
  }

  if (restoring || !introComplete) {
    return <BrandSplash />;
  }

  if (session) {
    return (
      <RidesHome
        session={session}
        onSignOut={signOut}
        onSessionChange={setSession}
        signingOut={busy}
        onEnablePushNotifications={enablePushNotifications}
        onDisablePushNotifications={disablePushNotifications}
        pushNotificationsEnabled={pushNotificationsEnabled}
        pushNotificationsBusy={pushNotificationsBusy}
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
        <ScrollView
          contentContainerStyle={styles.authPage}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
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
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function BrandSplash() {
  return (
    <View style={styles.splashScreen}>
      <StatusBar hidden />
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 390 844"
        preserveAspectRatio="xMidYMid slice"
        style={StyleSheet.absoluteFillObject}
      >
        <Defs>
          <LinearGradient id="navigoSky" x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor="#B9D8FA" />
            <Stop offset="43%" stopColor="#EAF4FF" />
            <Stop offset="100%" stopColor="#D8EAFE" />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="390" height="844" fill="url(#navigoSky)" />
        <Circle cx="318" cy="132" r="86" fill="#FFFFFF" opacity="0.14" />
        <Circle cx="60" cy="260" r="60" fill="#FFFFFF" opacity="0.12" />

        <Path
          d="M0 608 L0 565 L18 565 L18 535 L36 535 L36 556 L51 556 L51 505 L72 505 L72 559 L86 559 L86 480 L106 480 L106 558 L123 558 L123 524 L143 524 L143 566 L160 566 L160 506 L183 506 L183 564 L201 564 L201 462 L220 462 L220 562 L238 562 L238 526 L258 526 L258 565 L277 565 L277 498 L300 498 L300 559 L316 559 L316 525 L337 525 L337 564 L352 564 L352 512 L370 512 L370 563 L390 563 L390 632 Z"
          fill="#76A9E8"
          opacity="0.30"
        />
        <Path d="M0 624 L0 588 L26 588 L26 573 L45 573 L45 624 L66 624 L66 580 L89 580 L89 624 L111 624 L111 592 L135 592 L135 624 L153 624 L153 572 L174 572 L174 624 L197 624 L197 582 L221 582 L221 624 L245 624 L245 569 L270 569 L270 624 L290 624 L290 591 L312 591 L312 624 L338 624 L338 578 L361 578 L361 624 L390 624 L390 684 L0 684 Z" fill="#8BB9EE" opacity="0.25"/>

        <Path d="M0 667 C62 632 123 661 181 665 C246 670 319 628 390 617 L390 844 L0 844 Z" fill="#245EA8" />
        <Path d="M0 711 C76 670 131 715 199 713 C268 710 322 675 390 663 L390 844 L0 844 Z" fill="#12458F" />
        <Path d="M0 756 C82 723 139 757 213 752 C283 747 343 720 390 708 L390 844 L0 844 Z" fill="#092D70" />

        <Circle cx="116" cy="681" r="27" fill="none" stroke="#0A2A61" strokeWidth="8" />
        <Circle cx="270" cy="681" r="27" fill="none" stroke="#0A2A61" strokeWidth="8" />
        <Circle cx="116" cy="681" r="7" fill="#0A2A61" />
        <Circle cx="270" cy="681" r="7" fill="#0A2A61" />
        <Path
          d="M116 681 L155 642 L195 681 L270 681 L235 642 L202 642 L181 642"
          fill="none"
          stroke="#09295F"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Path d="M155 642 L177 625 L207 625 L235 642 L254 635" fill="none" stroke="#09295F" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <Path d="M202 642 L223 660 L247 660" fill="none" stroke="#09295F" strokeWidth="7" strokeLinecap="round" />
        <Path d="M167 640 L188 636 L211 648 L201 661 L174 659 Z" fill="#0A2B64" />
        <Circle cx="194" cy="574" r="15" fill="#08275C" />
        <Path d="M183 587 C170 596 163 610 160 628 L185 645 L211 617 L207 591 Z" fill="#08275C" />
        <Path d="M183 600 L215 624 L238 621" fill="none" stroke="#08275C" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
        <Path d="M188 625 L164 652 L191 662" fill="none" stroke="#08275C" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
        <Path d="M181 592 L205 601" fill="none" stroke="#08275C" strokeWidth="10" strokeLinecap="round" />
        <Path d="M190 557 L202 561 L205 574 L190 577 Z" fill="#08275C" />
        <Path d="M0 812 C105 784 173 813 248 800 C312 788 358 770 390 760 L390 844 L0 844 Z" fill="#062657" />
      </Svg>

      <View style={styles.splashBrand}>
        <Image source={require("./assets/icon.png")} style={styles.splashLogoImage} resizeMode="contain" />
        <Text style={styles.splashWordmark}>NAVIGO</Text>
        <Text style={styles.splashTagline}>Ride • Deliver • Move</Text>
      </View>
    </View>
  );
}

function Brand() {
  return (
    <View style={styles.brand}>
      <Image source={require("./assets/icon.png")} style={styles.brandLogo} resizeMode="contain" />
      <Text style={styles.brandName}>NAVIGO</Text>
      <Text style={styles.brandTagline}>Ride • Deliver • Move</Text>
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
  splashScreen: { flex: 1, backgroundColor: "#DCEEFF", overflow: "hidden" },
  splashBrand: { position: "absolute", top: "10%", left: 0, right: 0, alignItems: "center" },
  splashLogoImage: { width: 112, height: 112, borderRadius: 56, marginBottom: 5 },
  splashWordmark: { color: "#0B2E6B", fontSize: 35, fontWeight: "900", fontStyle: "italic", letterSpacing: 1.2 },
  splashTagline: { color: "#0B2E6B", fontSize: 14, fontWeight: "700", fontStyle: "italic", marginTop: 1 },
  brandLogo: { width: 58, height: 58, borderRadius: 16, marginBottom: 7 },
  safeArea: { flex: 1, backgroundColor: "#F3F6FA" },
  flex: { flex: 1 },
  authPage: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 25, paddingBottom: 28 },
  dashboard: { flexGrow: 1, paddingHorizontal: 24, paddingTop: 34, paddingBottom: 30 },
  brand: { alignItems: "center", marginBottom: 25 },
  brandMark: {
    width: 58, height: 58, borderRadius: 19, backgroundColor: "#174A72",
    alignItems: "center", justifyContent: "center", marginBottom: 9,
    shadowColor: "#174A72", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.18, shadowRadius: 9, elevation: 4
  },
  brandLetter: { color: "#FFFFFF", fontSize: 31, fontWeight: "800" },
  brandName: { color: "#174A72", fontSize: 25, fontWeight: "900", letterSpacing: 2.4 },
  brandTagline: { color: "#0B2E6B", fontSize: 12, fontStyle: "italic", fontWeight: "600", marginTop: 4, letterSpacing: 0.2 },
  headingBlock: { marginBottom: 19, paddingHorizontal: 3 },
  eyebrow: { color: "#2B719F", fontSize: 10, fontWeight: "800", letterSpacing: 1.4, marginBottom: 8 },
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
  modeTextActive: { color: "#174A72", fontWeight: "800" },
  roleSwitch: { flexDirection: "row", gap: 10, marginTop: 7, marginBottom: 16 },
  roleOption: {
    flex: 1, borderWidth: 1, borderColor: "#E0E6ED", borderRadius: 13,
    paddingVertical: 12, paddingHorizontal: 8, alignItems: "center", backgroundColor: "#FFFFFF"
  },
  roleOptionActive: { borderColor: "#2B719F", backgroundColor: "#F0F7FC" },
  roleText: { color: "#667085", fontWeight: "700", fontSize: 13 },
  roleTextActive: { color: "#174A72" },
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
  forgotText: { color: "#236B9A", fontSize: 12, fontWeight: "700" },
  riderSection: { backgroundColor: "#F7FAFC", borderRadius: 14, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: "#E8EEF4" },
  sectionLabel: { color: "#174A72", fontWeight: "800", fontSize: 13, marginBottom: 12 },
  helperText: { color: "#667085", fontSize: 11, lineHeight: 17, marginTop: 0 },
  errorBox: { backgroundColor: "#FEF3F2", borderRadius: 10, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: "#FEE4E2" },
  errorText: { color: "#B42318", fontSize: 12, lineHeight: 18 },
  primaryButton: {
    minHeight: 52, backgroundColor: "#174A72", borderRadius: 13,
    alignItems: "center", justifyContent: "center", marginTop: 3,
    shadowColor: "#174A72", shadowOffset: { width: 0, height: 5 },
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
    minHeight: 50, borderWidth: 1, borderColor: "#174A72", borderRadius: 13,
    backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", marginTop: 22
  },
  secondaryButtonText: { color: "#174A72", fontWeight: "700", fontSize: 14 },
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
