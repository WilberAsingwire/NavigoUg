# Android push notifications

NAVIGO stores in-app notification records as the source of truth and sends best-effort remote alerts through the Expo Push Service. A push delivery failure must not roll back a ride or parcel status change.

## Android credentials required

The existing Android application identifier is `ug.ac.muni.navigo`, and the EAS project ID is `701f22b6-271a-431f-bf23-e98745611ad3`.

Before building a device that can receive remote push notifications:

1. Create or open the Firebase project for NAVIGO.
2. Register an Android app in Firebase with package name `ug.ac.muni.navigo`.
3. Download that app's `google-services.json` file into `apps/mobile/`.
4. Add `googleServicesFile: "./google-services.json"` inside the `android` object in `apps/mobile/app.config.ts`.
5. In Firebase Project Settings → Service accounts, generate a Google service-account private key for FCM V1.
6. Upload that service-account JSON to the NAVIGO EAS project using the EAS credentials workflow (Android → Google Service Account → Manage the FCM V1 push-notification key), or through Expo's project credentials dashboard.

**Never commit the Google service-account private-key JSON.** Store it outside the repository and upload it directly to EAS. The Firebase `google-services.json` file contains app configuration identifiers; it is different from the service-account private key.

Official setup guide: https://docs.expo.dev/push-notifications/fcm-credentials/

## Build and test

Remote push notifications are not available in Expo Go on Android for SDK 53 and later. Use the development build profile:

```powershell
cd apps/mobile
eas build --profile development --platform android
```

Install the resulting APK on a physical Android device. Start the development server for that build:

```powershell
npx expo start --dev-client --clear
```

Sign in to NAVIGO, open Profile → Preferences → Notifications, and choose **Enable push alerts**. Android permission is requested only after this action. The app creates the Android notification channel before asking permission and registers the resulting Expo push token with the authenticated account.

To opt out, choose **Disable push alerts** in the same settings area. Signing out also attempts to unregister the device token.

## Booking events

The API keeps an in-app notification row and sends a push alert for these customer/sender events:

- Ride request created, accepted, rider arrived, trip started and completed.
- Parcel request created, accepted, rider arrived at pickup, collected, in transit, arrived at destination and delivery verified.

The rider's available-job list remains the source for new work; this implementation does not yet push new-job broadcasts to nearby riders.

## Delivery limitation

The API sends Expo push requests and removes tokens when Expo explicitly reports `DeviceNotRegistered` in its immediate ticket response. It does not yet run a receipt-polling job for later provider delivery failures. Treat delivery as best-effort until receipt processing and physical-device verification are added. The in-app notification inbox remains available as a fallback.
