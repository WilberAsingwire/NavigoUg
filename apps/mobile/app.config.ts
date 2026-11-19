import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "NAVIGO",
  slug: "navigo",
  scheme: "navigo",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  android: {
    package: "ug.ac.muni.navigo",
    versionCode: 1,
    permissions: [
      "ACCESS_COARSE_LOCATION",
      "ACCESS_FINE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "POST_NOTIFICATIONS"
    ]
  },
  plugins: [
    [
      "expo-location",
      {
        locationWhenInUsePermission:
          "NAVIGO uses your location to set pickup and destination points and share your position during an active booking.",
        isAndroidBackgroundLocationEnabled: true,
        isAndroidForegroundServiceEnabled: true
      }
    ],
    "expo-notifications",
    "expo-secure-store"
  ],
  extra: {
    eas: {
      projectId: "701f22b6-271a-431f-bf23-e98745611ad3"
    }
  }
};

export default config;