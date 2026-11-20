# NAVIGO cloud preview updates

NAVIGO uses Expo Update for internal Android previews so normal JavaScript and interface changes can be reviewed without running the Expo development server on a laptop.

## How it works

- The installed Android preview APK uses the EAS `preview` channel.
- Expo Update targets runtime version `1.0.0`, derived from the app version.
- GitHub Actions publishes an update to the shared `preview` channel after pushes to branches other than `main`.
- The workflow uses the repository secret `EXPO_TOKEN`. If it is not configured, publishing is skipped and the workflow displays a notice.

## One-time setup

1. Create an Expo access token at https://expo.dev/settings/access-tokens.
2. In GitHub, open **Settings → Secrets and variables → Actions** for this repository and add a repository secret named `EXPO_TOKEN`. Never commit the token or paste it into source code.
3. In GitHub **Actions**, select **NAVIGO preview APK** and click **Run workflow**. This starts a cloud Android build using the EAS `preview` profile. Download and install the resulting APK from the build link in the workflow output or Expo dashboard.
4. Keep this preview APK installed for subsequent UI testing.

## Reviewing changes

After code is pushed to the repository, GitHub Actions publishes the JavaScript bundle and assets to the EAS `preview` channel. Open NAVIGO with an internet connection to download the update. The downloaded update is applied on a subsequent app launch; close and reopen the app if the first launch only downloads it.

The preview channel is shared: the latest successful update published from any non-`main` branch becomes the preview currently offered to the test APK. Avoid publishing unrelated branches at the same time.

## What can update over the air

JavaScript/TypeScript logic, React Native screens, text, layout, styling, and compatible bundled assets can be updated without installing a new APK.

A new Android build is still required for native dependencies, Expo SDK upgrades, native configuration or permission changes, and other changes that alter the app's native runtime. The runtime version prevents an update from being delivered to an incompatible binary.
