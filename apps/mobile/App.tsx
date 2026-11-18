import { StatusBar } from "expo-status-bar";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

export default function App() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.container}>
        <View style={styles.brandMark}><Text style={styles.brandLetter}>N</Text></View>
        <Text style={styles.title}>NAVIGO</Text>
        <Text style={styles.subtitle}>Your ride. Your parcel. Connected.</Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>A simpler way to move</Text>
          <Text style={styles.body}>
            Request a motorcycle ride or arrange collection and delivery of a ready parcel.
          </Text>
          <Text style={styles.status}>Project foundation is being prepared.</Text>
        </View>
        <Text style={styles.footer}>Muni University • Arua, Uganda</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F5F7FB" },
  container: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 24 },
  brandMark: { width: 72, height: 72, borderRadius: 22, backgroundColor: "#153A63", alignItems: "center", justifyContent: "center", marginBottom: 14 },
  brandLetter: { color: "#FFFFFF", fontSize: 38, fontWeight: "800" },
  title: { color: "#153A63", fontSize: 31, fontWeight: "800", letterSpacing: 2 },
  subtitle: { color: "#667085", fontSize: 14, marginTop: 6 },
  card: { width: "100%", backgroundColor: "#FFFFFF", borderRadius: 20, padding: 22, marginTop: 36, borderWidth: 1, borderColor: "#E7ECF2" },
  cardTitle: { color: "#182230", fontSize: 19, fontWeight: "700" },
  body: { color: "#667085", fontSize: 14, lineHeight: 22, marginTop: 10 },
  status: { color: "#146C43", fontSize: 13, fontWeight: "600", marginTop: 20 },
  footer: { color: "#98A2B3", fontSize: 12, marginTop: 40 }
});
