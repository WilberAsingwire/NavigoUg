import { Component, type ErrorInfo, type ReactNode } from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";

type Props = { children: ReactNode };
type State = { error: Error | null };

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("NAVIGO screen error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.card}>
            <Text style={styles.brand}>NAVIGO</Text>
            <Text style={styles.title}>NAVIGO could not open this screen</Text>
            <Text style={styles.help}>
              The app started, but a screen encountered an error. Please share this message with the NAVIGO development team.
            </Text>
            <Text selectable style={styles.error}>
              {this.state.error.name}: {this.state.error.message}
            </Text>
          </View>
        </SafeAreaView>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#EDF6FF",
    justifyContent: "center",
    padding: 24
  },
  card: {
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    padding: 22,
    borderWidth: 1,
    borderColor: "#D8E4EF"
  },
  brand: {
    color: "#174A72",
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 2,
    marginBottom: 16
  },
  title: {
    color: "#152536",
    fontSize: 21,
    fontWeight: "700",
    marginBottom: 10
  },
  help: {
    color: "#526273",
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 16
  },
  error: {
    color: "#8B1E2D",
    backgroundColor: "#FFF1F1",
    borderRadius: 10,
    padding: 12,
    fontSize: 12,
    lineHeight: 18
  }
});
