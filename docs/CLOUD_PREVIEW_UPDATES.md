# NAVIGO cloud preview updates

NAVIGO uses Expo Update for internal Android previews so normal JavaScript and interface changes can be reviewed without running the Expo development server on a laptop.

## How it works

- The installed Android preview APK uses the EAS `preview` channel.
- Expo Update targets a runtime version derived from the app version (currently `1.0.0`). Increment the app version whenever a native runtime change requires a new APK.
- GitHub Actions publishes an update to the shared `preview` channel after pushes to branches other than `main`.
- The repository secret `EXPO_TOKEN` authenticates both cloud updates and cloud builds. If it is missing, the workflows skip their Expo steps and display a notice.
- The Android preview APK workflow runs when mobile native configuration files change. It does not rebuild for ordinary JavaScript or UI edits.

## One-time setup

1. Create an Expo access token at https://expo.dev/settings/access-tokens.
2. In GitHub, open **Settings → Secrets and variables → Actions** for this repository and add a repository secret named `EXPO_TOKEN`. Never commit the token or paste it into source code.
3. Trigger one Android APK build using the EAS `preview` profile. The build workflow is configured to run on native mobile configuration changes. Download and install the resulting APK from the EAS build link.
4. Keep this preview APK installed for subsequent UI testing.

## Reviewing changes

After code is pushed to the repository, GitHub Actions publishes the JavaScript bundle and assets using the EAS `preview` environment and channel. Open NAVIGO with an internet connection to download the update. The downloaded update is applied on a subsequent app launch; close and reopen the app if the first launch only downloads it.

The preview channel is shared: the latest successful update published from any non-`main` branch becomes the preview currently offered to the test APK. Avoid publishing unrelated branches at the same time.

## What can update over the air

JavaScript/TypeScript logic, React Native screens, text, layout, styling, and compatible bundled assets can be updated without installing a new APK.

A new Android build is still required for native dependencies, Expo SDK upgrades, native configuration or permission changes, and other changes that alter the app's native runtime. The runtime version prevents an update from being delivered to an incompatible binary.
