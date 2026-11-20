import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
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
  const [welcomeComplete, setWelcomeComplete] = useState(false);
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

    // Do not leave the app on the opening screen forever if Android secure storage stalls.
    const restoreTimeout = setTimeout(() => {
      if (!mounted) return;
      setError("Your previous session could not be restored. Please sign in again.");
      setRestoring(false);
    }, 10000);

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
        clearTimeout(restoreTimeout);
        if (mounted) setRestoring(false);
      });

    return () => {
      mounted = false;
      clearTimeout(restoreTimeout);
    };
  }, []);

  useEffect(() => {
    // Keep the branded intro visible briefly, without depending on storage restore.
    const timer = setTimeout(() => setIntroComplete(true), 2600);
    return () => clearTimeout(timer);
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
      setWelcomeComplete(false);
      setBusy(false);
    }
  }

  if (restoring || !introComplete) {
    return <BrandSplash onComplete={() => setIntroComplete(true)} />;
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

  if (!welcomeComplete) {
    return (
      <WelcomeScreen
        onLogin={() => {
          setMode("login");
          setError("");
          setShowPassword(false);
          setWelcomeComplete(true);
        }}
        onRegister={() => {
          setMode("register");
          setError("");
          setShowPassword(false);
          setWelcomeComplete(true);
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
        <ScrollView
          contentContainerStyle={styles.authPage}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Brand />
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.backToWelcome}
            onPress={() => {
              setWelcomeComplete(false);
              setError("");
              setShowPassword(false);
            }}
          >
            <Text style={styles.backToWelcomeText}>‹  Back to welcome</Text>
          </TouchableOpacity>
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

function BrandSplash({ onComplete }: { onComplete: () => void }) {
  const logoScale = useRef(new Animated.Value(0.72)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const titleOpacity = useRef(new Animated.Value(0)).current;
  const titleY = useRef(new Animated.Value(22)).current;
  const taglineOpacity = useRef(new Animated.Value(0)).current;
  const roadWidth = useRef(new Animated.Value(0)).current;
  const screenOpacity = useRef(new Animated.Value(1)).current;
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(logoOpacity, { toValue: 1, duration: 550, useNativeDriver: true }),
        Animated.spring(logoScale, { toValue: 1, friction: 6, tension: 55, useNativeDriver: true })
      ]),
      Animated.parallel([
        Animated.timing(titleOpacity, { toValue: 1, duration: 450, useNativeDriver: true }),
        Animated.timing(titleY, { toValue: 0, duration: 500, easing: Easing.out(Easing.cubic), useNativeDriver: true })
      ]),
      Animated.parallel([
        Animated.timing(taglineOpacity, { toValue: 1, duration: 400, useNativeDriver: true }),
        Animated.timing(roadWidth, { toValue: 1, duration: 850, easing: Easing.out(Easing.cubic), useNativeDriver: false })
      ]),
      Animated.delay(650),
      Animated.timing(screenOpacity, { toValue: 0, duration: 500, easing: Easing.out(Easing.quad), useNativeDriver: true })
    ]).start(({ finished }) => {
      if (finished) onCompleteRef.current();
    });
  }, [logoOpacity, logoScale, titleOpacity, titleY, taglineOpacity, roadWidth, screenOpacity]);

  return (
    <Animated.View style={[styles.splashScreen, { opacity: screenOpacity }]}>
      <StatusBar hidden />
      <View pointerEvents="none" style={styles.splashGlowTop} />
      <View style={styles.splashGlowBottom} />
      <View style={styles.splashContent}>
        <Animated.View style={[styles.splashLogoShell, { opacity: logoOpacity, transform: [{ scale: logoScale }] }]}>
          <Image source={require("./assets/icon.png")} style={styles.splashLogo} resizeMode="contain" />
        </Animated.View>
        <Animated.Text style={[styles.splashWordmark, { opacity: titleOpacity, transform: [{ translateY: titleY }] }]}>
          NAVIGO
        </Animated.Text>
        <Animated.Text style={[styles.splashTagline, { opacity: taglineOpacity }]}>
          Ride  •  Deliver  •  Move
        </Animated.Text>
        <View style={styles.splashRoadTrack}>
          <Animated.View style={[styles.splashRoadLine, { transform: [{ scaleX: roadWidth }] }]} />
        </View>
        <Animated.Text style={[styles.splashLocation, { opacity: taglineOpacity }]}>
          YOUR JOURNEY STARTS HERE
        </Animated.Text>
      </View>
      <View style={styles.splashFooter}>
        <View style={styles.splashFooterDot} />
        <Text style={styles.splashFooterText}>ARUA  •  UGANDA</Text>
      </View>
    </Animated.View>
  );
}

type WelcomeScreenProps = {
  onLogin: () => void;
  onRegister: () => void;
};

function WelcomeScreen({ onLogin, onRegister }: WelcomeScreenProps) {
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentY = useRef(new Animated.Value(24)).current;
  const cardsOpacity = useRef(new Animated.Value(0)).current;
  const onLoginRef = useRef(onLogin);
  const onRegisterRef = useRef(onRegister);
  onLoginRef.current = onLogin;
  onRegisterRef.current = onRegister;

  useEffect(() => {
    Animated.sequence([
      Animated.parallel([
        Animated.timing(contentOpacity, { toValue: 1, duration: 520, useNativeDriver: true }),
        Animated.timing(contentY, { toValue: 0, duration: 620, easing: Easing.out(Easing.cubic), useNativeDriver: true })
      ]),
      Animated.timing(cardsOpacity, { toValue: 1, duration: 420, useNativeDriver: true })
    ]).start();
  }, [contentOpacity, contentY, cardsOpacity]);

  return (
    <SafeAreaView style={styles.welcomeScreen}>
      <StatusBar style="dark" backgroundColor="#F4F8FE" />
      <View pointerEvents="none" style={styles.welcomeGlowTop} />
      <View pointerEvents="none" style={styles.welcomeGlowBottom} />
      <ScrollView
        contentContainerStyle={styles.welcomePage}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View style={styles.welcomeHeader}>
          <View style={styles.welcomeBrand}>
            <Image source={require("./assets/icon.png")} style={styles.welcomeLogo} resizeMode="contain" />
            <View>
              <Text style={styles.welcomeBrandName}>NAVIGO</Text>
              <Text style={styles.welcomeBrandTagline}>Ride • Deliver • Move</Text>
            </View>
          </View>
          <View style={styles.welcomeLocationPill}>
            <View style={styles.welcomeLocationDot} />
            <Text style={styles.welcomeLocationText}>ARUA</Text>
          </View>
        </View>

        <Animated.View
          style={[
            styles.welcomeHero,
            { opacity: contentOpacity, transform: [{ translateY: contentY }] }
          ]}
        >
          <View pointerEvents="none" style={styles.welcomeHeroOrbLarge} />
          <View pointerEvents="none" style={styles.welcomeHeroOrbSmall} />
          <Text style={styles.welcomeEyebrow}>YOUR CITY, CONNECTED</Text>
          <Text style={styles.welcomeHeadline}>Move around.{"\n"}Send with ease.</Text>
          <Text style={styles.welcomeDescription}>
            Book a motorcycle ride or get your ready parcel collected and delivered — all in one place.
          </Text>
          <View style={styles.welcomeHeroBottom}>
            <View style={styles.welcomeHeroBadge}>
              <Text style={styles.welcomeHeroBadgeIcon}>N</Text>
            </View>
            <View style={styles.welcomeHeroBottomText}>
              <Text style={styles.welcomeHeroBottomTitle}>Everyday journeys, made simpler</Text>
              <Text style={styles.welcomeHeroBottomSubtitle}>A smarter way to move in Arua</Text>
            </View>
            <View style={styles.welcomeHeroArrow}>
              <Text style={styles.welcomeHeroArrowText}>↗</Text>
            </View>
          </View>
        </Animated.View>

        <Animated.View style={{ opacity: cardsOpacity }}>
          <Text style={styles.welcomeSectionLabel}>WHAT YOU CAN DO WITH NAVIGO</Text>
          <View style={styles.welcomeServices}>
            <View style={styles.welcomeServiceCard}>
              <View style={styles.welcomeServiceIconRide}>
                <Text style={styles.welcomeServiceEmoji}>🏍️</Text>
              </View>
              <Text style={styles.welcomeServiceTitle}>Book a ride</Text>
              <Text style={styles.welcomeServiceDescription}>Get where you need to go with a nearby rider.</Text>
            </View>
            <View style={styles.welcomeServiceCard}>
              <View style={styles.welcomeServiceIconParcel}>
                <Text style={styles.welcomeServiceEmoji}>📦</Text>
              </View>
              <Text style={styles.welcomeServiceTitle}>Send a parcel</Text>
              <Text style={styles.welcomeServiceDescription}>Have a ready package collected and delivered.</Text>
            </View>
          </View>
        </Animated.View>

        <View style={styles.welcomeActions}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Create a NAVIGO account"
            style={styles.welcomeCreateButton}
            onPress={() => onRegisterRef.current()}
            activeOpacity={0.88}
          >
            <Text style={styles.welcomeCreateButtonText}>Create your account</Text>
            <View style={styles.welcomeButtonArrow}>
              <Text style={styles.welcomeButtonArrowText}>→</Text>
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel="Log in to NAVIGO"
            style={styles.welcomeLoginButton}
            onPress={() => onLoginRef.current()}
            activeOpacity={0.86}
          >
            <Text style={styles.welcomeLoginButtonText}>I already have an account</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.welcomeFooter}>
          <Text style={styles.welcomeFooterText}>MADE FOR ARUA</Text>
          <View style={styles.welcomeFooterDivider} />
          <Text style={styles.welcomeFooterText}>UGANDA</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
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
  splashScreen: { flex: 1, backgroundColor: "#F4F9FF", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  splashGlowTop: { position: "absolute", width: 340, height: 340, borderRadius: 170, backgroundColor: "#E2F0FF", top: -170, right: -120 },
  splashGlowBottom: { position: "absolute", width: 300, height: 300, borderRadius: 150, backgroundColor: "#EAF3FF", bottom: -190, left: -100 },
  splashContent: { width: "100%", alignItems: "center", justifyContent: "center", paddingHorizontal: 28, marginTop: -20 },
  splashLogoShell: { width: 154, height: 154, borderRadius: 42, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", shadowColor: "#0B2E6B", shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.15, shadowRadius: 22, elevation: 9, marginBottom: 25 },
  splashLogo: { width: 132, height: 132, borderRadius: 34 },
  splashWordmark: { color: "#0B2E6B", fontSize: 46, fontWeight: "900", fontStyle: "italic", letterSpacing: 2.2 },
  splashTagline: { color: "#24558C", fontSize: 16, fontWeight: "700", marginTop: 9, letterSpacing: 0.25 },
  splashRoadTrack: { width: 190, height: 5, borderRadius: 3, backgroundColor: "#D9E9FC", overflow: "hidden", marginTop: 31 },
  splashRoadLine: { width: "100%", height: 5, borderRadius: 3, backgroundColor: "#F2A900", transformOrigin: "left" },
  splashLocation: { color: "#6A83A5", fontSize: 10, fontWeight: "800", letterSpacing: 2.2, marginTop: 17 },
  splashFooter: { position: "absolute", bottom: 42, flexDirection: "row", alignItems: "center", gap: 8 },
  splashFooterDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#F2A900" },
  splashFooterText: { color: "#6680A2", fontSize: 10, fontWeight: "800", letterSpacing: 2.1 },
  brandLogo: { width: 58, height: 58, borderRadius: 16, marginBottom: 7 },
  welcomeScreen: { flex: 1, backgroundColor: "#F4F8FE", overflow: "hidden" },
  welcomeGlowTop: { position: "absolute", width: 300, height: 300, borderRadius: 150, backgroundColor: "#E6F0FF", top: -185, right: -125 },
  welcomeGlowBottom: { position: "absolute", width: 270, height: 270, borderRadius: 135, backgroundColor: "#EAF2FC", bottom: -175, left: -140 },
  welcomePage: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 12, paddingBottom: 24 },
  welcomeHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 25 },
  welcomeBrand: { flexDirection: "row", alignItems: "center", gap: 11 },
  welcomeLogo: { width: 48, height: 48, borderRadius: 15 },
  welcomeBrandName: { color: "#0B2E6B", fontSize: 19, fontWeight: "900", letterSpacing: 1.3 },
  welcomeBrandTagline: { color: "#6680A2", fontSize: 10, fontWeight: "600", marginTop: 1 },
  welcomeLocationPill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#E7F0FD", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 8 },
  welcomeLocationDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: "#E9A400" },
  welcomeLocationText: { color: "#244D7C", fontSize: 10, fontWeight: "900", letterSpacing: 1.1 },
  welcomeHero: { backgroundColor: "#0B2E6B", borderRadius: 28, padding: 22, overflow: "hidden", minHeight: 272, justifyContent: "space-between", shadowColor: "#0B2E6B", shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.16, shadowRadius: 20, elevation: 7 },
  welcomeHeroOrbLarge: { position: "absolute", width: 230, height: 230, borderRadius: 115, backgroundColor: "#174A92", top: -110, right: -90 },
  welcomeHeroOrbSmall: { position: "absolute", width: 130, height: 130, borderRadius: 65, borderWidth: 1, borderColor: "#416BA5", bottom: -78, right: 35 },
  welcomeEyebrow: { color: "#F4BD41", fontSize: 10, fontWeight: "900", letterSpacing: 2 },
  welcomeHeadline: { color: "#FFFFFF", fontSize: 34, lineHeight: 40, fontWeight: "900", letterSpacing: -0.8, marginTop: 17 },
  welcomeDescription: { color: "#D5E4F8", fontSize: 13, lineHeight: 20, marginTop: 12, maxWidth: 295 },
  welcomeHeroBottom: { flexDirection: "row", alignItems: "center", marginTop: 23 },
  welcomeHeroBadge: { width: 36, height: 36, borderRadius: 12, backgroundColor: "#F2B632", alignItems: "center", justifyContent: "center" },
  welcomeHeroBadgeIcon: { color: "#0B2E6B", fontSize: 20, fontWeight: "900", fontStyle: "italic" },
  welcomeHeroBottomText: { flex: 1, marginLeft: 10 },
  welcomeHeroBottomTitle: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" },
  welcomeHeroBottomSubtitle: { color: "#AFC8E8", fontSize: 10, marginTop: 3 },
  welcomeHeroArrow: { width: 30, height: 30, borderRadius: 15, backgroundColor: "#244D83", alignItems: "center", justifyContent: "center" },
  welcomeHeroArrowText: { color: "#FFFFFF", fontSize: 18, fontWeight: "700", marginTop: -2 },
  welcomeSectionLabel: { color: "#6B82A0", fontSize: 10, fontWeight: "900", letterSpacing: 1.4, marginTop: 25, marginBottom: 12 },
  welcomeServices: { flexDirection: "row", gap: 11 },
  welcomeServiceCard: { flex: 1, minHeight: 145, backgroundColor: "#FFFFFF", borderRadius: 20, padding: 14, borderWidth: 1, borderColor: "#E5EDF7", shadowColor: "#163A69", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.04, shadowRadius: 10, elevation: 2 },
  welcomeServiceIconRide: { width: 42, height: 42, borderRadius: 14, backgroundColor: "#E9F2FF", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  welcomeServiceIconParcel: { width: 42, height: 42, borderRadius: 14, backgroundColor: "#FFF3D7", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  welcomeServiceEmoji: { fontSize: 21 },
  welcomeServiceTitle: { color: "#15345F", fontSize: 13, fontWeight: "900" },
  welcomeServiceDescription: { color: "#718096", fontSize: 10, lineHeight: 15, marginTop: 5 },
  welcomeActions: { marginTop: 22, gap: 10 },
  welcomeCreateButton: { minHeight: 56, borderRadius: 17, backgroundColor: "#F2B632", flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 15, shadowColor: "#A97910", shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.15, shadowRadius: 9, elevation: 3 },
  welcomeCreateButtonText: { color: "#0B2E6B", fontSize: 14, fontWeight: "900" },
  welcomeButtonArrow: { position: "absolute", right: 13, width: 32, height: 32, borderRadius: 11, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  welcomeButtonArrowText: { color: "#0B2E6B", fontSize: 20, fontWeight: "700", marginTop: -2 },
  welcomeLoginButton: { minHeight: 53, borderRadius: 17, borderWidth: 1.5, borderColor: "#C9D8EC", backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  welcomeLoginButtonText: { color: "#173D70", fontSize: 13, fontWeight: "800" },
  welcomeFooter: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 11, marginTop: 23 },
  welcomeFooterText: { color: "#91A4BD", fontSize: 9, fontWeight: "900", letterSpacing: 1.7 },
  welcomeFooterDivider: { height: 12, width: 1, backgroundColor: "#CBD9EB" },
  backToWelcome: { alignSelf: "flex-start", marginTop: -11, marginBottom: 15, paddingVertical: 5, paddingHorizontal: 2 },
  backToWelcomeText: { color: "#2B719F", fontSize: 12, fontWeight: "700" },
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
