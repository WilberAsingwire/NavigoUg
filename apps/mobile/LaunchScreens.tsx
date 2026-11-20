import {
  ActivityIndicator,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { BRAND_COLORS } from "./brand";

type WelcomeScreenProps = {
  onGetStarted: () => void;
  onCreateAccount: () => void;
};

export function SplashScreen() {
  return (
    <SafeAreaView style={splashStyles.safeArea}>
      <StatusBar style="light" />
      <View style={splashStyles.content}>
        <View style={splashStyles.logoGlow}>
          <Image source={require("./assets/icon.png")} style={splashStyles.logoImage} resizeMode="contain" accessibilityLabel="NAVIGO logo" />
        </View>
        <Text style={splashStyles.wordmark}>NAVIGO</Text>
        <Text style={splashStyles.tagline}>Your journey, made easier.</Text>
        <View style={splashStyles.loading}>
          <ActivityIndicator size="small" color={BRAND_COLORS.gold} />
          <Text style={splashStyles.loadingText}>Getting things ready...</Text>
        </View>
      </View>
      <Text style={splashStyles.footer}>MUNI UNIVERSITY  •  ARUA, UGANDA</Text>
    </SafeAreaView>
  );
}

export function WelcomeScreen({ onGetStarted, onCreateAccount }: WelcomeScreenProps) {
  return (
    <SafeAreaView style={welcomeStyles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={welcomeStyles.page}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        <View style={welcomeStyles.header}>
          <View style={welcomeStyles.brand}>
            <Image source={require("./assets/icon.png")} style={welcomeStyles.brandMark} resizeMode="contain" accessibilityLabel="NAVIGO logo" />
            <View>
              <Text style={welcomeStyles.brandName}>NAVIGO</Text>
              <Text style={welcomeStyles.brandTagline}>Your journey, made easier.</Text>
            </View>
          </View>
          <View style={welcomeStyles.locationPill}>
            <View style={welcomeStyles.locationDot} />
            <Text style={welcomeStyles.locationText}>ARUA, UGANDA</Text>
          </View>
        </View>

        <View style={welcomeStyles.hero}>
          <View style={welcomeStyles.eyebrow}>
            <Text style={welcomeStyles.eyebrowText}>MOVE • CONNECT • DELIVER</Text>
          </View>
          <Text style={welcomeStyles.title}>Wherever you're going, NAVIGO gets you moving.</Text>
          <Text style={welcomeStyles.description}>
            Book a motorcycle ride or have a ready parcel collected and delivered. Getting around Arua is easier when everything you need is in one place.
          </Text>
        </View>

        <View style={welcomeStyles.routeIllustration}>
          <View style={welcomeStyles.routeTopRow}>
            <View>
              <Text style={welcomeStyles.routeEyebrow}>YOUR NEXT JOURNEY</Text>
              <Text style={welcomeStyles.routeTitle}>A better way to get there</Text>
            </View>
            <View style={welcomeStyles.routeIcon}>
              <Text style={welcomeStyles.routeIconText}>↗</Text>
            </View>
          </View>
          <View style={welcomeStyles.routePath}>
            <View style={welcomeStyles.routeStops}>
              <View style={welcomeStyles.pickupPin} />
              <View style={welcomeStyles.pathLine} />
              <View style={welcomeStyles.destinationPin} />
            </View>
            <View style={welcomeStyles.routeLabels}>
              <View>
                <Text style={welcomeStyles.stopLabel}>PICKUP</Text>
                <Text style={welcomeStyles.stopName}>Your location</Text>
              </View>
              <View style={welcomeStyles.destinationLabelBlock}>
                <Text style={welcomeStyles.stopLabel}>DESTINATION</Text>
                <Text style={welcomeStyles.stopName}>Where you need to be</Text>
              </View>
            </View>
          </View>
          <View style={welcomeStyles.routeDivider} />
          <Text style={welcomeStyles.routeFootnote}>Simple bookings. Clear fares. Reliable connections.</Text>
        </View>

        <View style={welcomeStyles.services}>
          <View style={[welcomeStyles.serviceCard, welcomeStyles.rideCard]}>
            <View style={welcomeStyles.serviceIconRide}>
              <Text style={welcomeStyles.serviceEmoji}>🏍️</Text>
            </View>
            <Text style={welcomeStyles.serviceTitle}>Motorcycle rides</Text>
            <Text style={welcomeStyles.serviceDescription}>Get to your destination with a nearby rider.</Text>
          </View>
          <View style={[welcomeStyles.serviceCard, welcomeStyles.parcelCard]}>
            <View style={welcomeStyles.serviceIconParcel}>
              <Text style={welcomeStyles.serviceEmoji}>📦</Text>
            </View>
            <Text style={welcomeStyles.serviceTitle}>Ready parcels</Text>
            <Text style={welcomeStyles.serviceDescription}>Have an item collected and delivered for you.</Text>
          </View>
        </View>

        <View style={welcomeStyles.actions}>
          <TouchableOpacity
            accessibilityRole="button"
            style={welcomeStyles.primaryButton}
            activeOpacity={0.88}
            onPress={onGetStarted}
          >
            <Text style={welcomeStyles.primaryButtonText}>Get started</Text>
            <Text style={welcomeStyles.primaryButtonArrow}>→</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            style={welcomeStyles.secondaryButton}
            activeOpacity={0.78}
            onPress={onCreateAccount}
          >
            <Text style={welcomeStyles.secondaryButtonText}>Create an account</Text>
          </TouchableOpacity>
          <Text style={welcomeStyles.terms}>
            By continuing, you agree to use NAVIGO responsibly and provide accurate booking details.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const splashStyles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: BRAND_COLORS.navy },
  content: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28 },
  logoGlow: { width: 124, height: 124, borderRadius: 30, overflow: "hidden", backgroundColor: "#EDF4FF", marginBottom: 24, shadowColor: "#061D31", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 15, elevation: 7 },
  logoImage: { width: "100%", height: "100%" },
  wordmark: { color: "#FFFFFF", fontSize: 31, fontWeight: "900", letterSpacing: 4 },
  tagline: { color: "#D7E8F5", fontSize: 14, marginTop: 8, letterSpacing: 0.3 },
  loading: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 48 },
  loadingText: { color: "#D7E8F5", fontSize: 12, letterSpacing: 0.2 },
  footer: { color: "#B7D0E3", fontSize: 9, fontWeight: "800", letterSpacing: 1.5, textAlign: "center", paddingBottom: 24 }
});

const welcomeStyles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F3F7FB" },
  page: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 16, paddingBottom: 25 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 34 },
  brand: { flexDirection: "row", alignItems: "center", gap: 10 },
  brandMark: { width: 43, height: 43, borderRadius: 14, backgroundColor: BRAND_COLORS.navy, alignItems: "center", justifyContent: "center" },
  brandLetter: { color: "#FFFFFF", fontSize: 25, fontWeight: "900" },
  brandName: { color: "#174A72", fontSize: 17, fontWeight: "900", letterSpacing: 2 },
  brandTagline: { color: "#7B8794", fontSize: 9, marginTop: 2 },
  locationPill: { flexDirection: "row", alignItems: "center", backgroundColor: BRAND_COLORS.blueTint, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 20 },
  locationDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: BRAND_COLORS.gold, marginRight: 6 },
  locationText: { color: BRAND_COLORS.navy, fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },
  hero: { marginBottom: 21 },
  eyebrow: { alignSelf: "flex-start", backgroundColor: BRAND_COLORS.goldTint, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 7, marginBottom: 13 },
  eyebrowText: { color: BRAND_COLORS.orange, fontSize: 9, fontWeight: "900", letterSpacing: 1.3 },
  title: { color: "#142B3D", fontSize: 31, lineHeight: 38, fontWeight: "900", letterSpacing: -0.7 },
  description: { color: "#667788", fontSize: 13, lineHeight: 21, marginTop: 12 },
  routeIllustration: {
    backgroundColor: "#FFFFFF",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#E4EBF1",
    padding: 17,
    shadowColor: "#18374D",
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.045,
    shadowRadius: 12,
    elevation: 2,
    marginBottom: 15
  },
  routeTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  routeEyebrow: { color: "#8293A1", fontSize: 8, fontWeight: "900", letterSpacing: 1.3 },
  routeTitle: { color: "#20384B", fontSize: 14, fontWeight: "800", marginTop: 5 },
  routeIcon: { width: 32, height: 32, borderRadius: 11, backgroundColor: BRAND_COLORS.orangeTint, alignItems: "center", justifyContent: "center" },
  routeIconText: { color: BRAND_COLORS.orange, fontSize: 20, fontWeight: "700", marginTop: -2 },
  routePath: { flexDirection: "row", marginTop: 21, minHeight: 73 },
  routeStops: { width: 22, alignItems: "center", paddingTop: 4 },
  pickupPin: { width: 10, height: 10, borderWidth: 3, borderColor: BRAND_COLORS.gold, borderRadius: 5, backgroundColor: "#FFFFFF", zIndex: 1 },
  pathLine: { width: 2, height: 36, backgroundColor: BRAND_COLORS.gold },
  destinationPin: { width: 10, height: 10, borderRadius: 3, backgroundColor: BRAND_COLORS.orange, marginTop: 0 },
  routeLabels: { flex: 1, justifyContent: "space-between", paddingBottom: 1 },
  stopLabel: { color: "#8796A3", fontSize: 8, fontWeight: "900", letterSpacing: 1 },
  stopName: { color: "#344B5D", fontSize: 12, fontWeight: "700", marginTop: 3 },
  destinationLabelBlock: { marginTop: 9 },
  routeDivider: { height: 1, backgroundColor: "#EEF2F5", marginTop: 8 },
  routeFootnote: { color: "#758493", fontSize: 10, marginTop: 10 },
  services: { flexDirection: "row", gap: 11, marginBottom: 20 },
  serviceCard: { flex: 1, minHeight: 132, borderRadius: 17, padding: 13, borderWidth: 1 },
  rideCard: { backgroundColor: "#EEF6FB", borderColor: "#DCEAF4" },
  parcelCard: { backgroundColor: BRAND_COLORS.goldTint, borderColor: "#F0DFB5" },
  serviceIconRide: { width: 35, height: 35, borderRadius: 11, backgroundColor: "#DCECF7", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  serviceIconParcel: { width: 35, height: 35, borderRadius: 11, backgroundColor: "#FCE9C8", alignItems: "center", justifyContent: "center", marginBottom: 10 },
  serviceEmoji: { fontSize: 17 },
  serviceTitle: { color: "#263E50", fontSize: 12, fontWeight: "900" },
  serviceDescription: { color: "#71818E", fontSize: 10, lineHeight: 15, marginTop: 5 },
  actions: { marginTop: 0 },
  primaryButton: { minHeight: 54, backgroundColor: "#174A72", borderRadius: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 18, shadowColor: BRAND_COLORS.navy, shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.15, shadowRadius: 9, elevation: 3 },
  primaryButtonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "900", letterSpacing: 0.2 },
  primaryButtonArrow: { position: "absolute", right: 19, color: BRAND_COLORS.gold, fontSize: 20, fontWeight: "700" },
  secondaryButton: { minHeight: 50, borderRadius: 14, borderWidth: 1, borderColor: BRAND_COLORS.gold, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", marginTop: 10 },
  secondaryButtonText: { color: BRAND_COLORS.navy, fontSize: 13, fontWeight: "800" },
  terms: { color: "#9AA6B1", fontSize: 9, lineHeight: 14, textAlign: "center", marginTop: 13, paddingHorizontal: 8 }
});
