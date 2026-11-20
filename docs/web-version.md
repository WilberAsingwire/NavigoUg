# NAVIGO browser build

The browser version is being added to the existing Expo mobile workspace. It shares the existing NAVIGO API, accounts, workflows and PostgreSQL database; it does not create a second backend or database.

## Development

From the repository root:

```sh
npm install
npm run dev:web
```

Export a production browser bundle:

```sh
npm run build:web
```

The Expo web export is written to `apps/mobile/dist` by default. The Android start and EAS build commands remain separate and unchanged.

## Platform differences

- Android and iOS continue to use Expo SecureStore through `AppStorage.ts`.
- Web uses `sessionStorage` for the authentication session (tab-scoped) and `localStorage` for non-sensitive UI preferences. Browser storage is accessible to page JavaScript and is not equivalent to OS-encrypted SecureStore.
- The web map uses the existing OpenStreetMap raster renderer. iOS continues to use `react-native-maps`; Android continues to use the raster renderer.
- Browser geolocation requires the user to grant permission and the site to run in a secure context (HTTPS, or localhost during development). Background tracking is not provided by the browser build.
- Reverse geocoding through the native Expo Location method is skipped on web; the interface uses a neutral current-location label while the existing backend search and fare services remain shared.

## API origin security

The API enforces an explicit `CORS_ORIGINS` allow-list. Before browser sign-in can work from a deployed site, add that exact HTTPS origin to the API environment variable. Do not use a wildcard origin. For local development, add the exact Expo web origin (normally `http://localhost:8081`) only in the development environment if needed. No live Render environment variable is changed by this web-support branch.

## Scope of this first increment

This increment enables the browser target and checks that its bundle compiles. It is not a production deployment. The browser build still needs interactive testing for customer, rider and administrator journeys, map behaviour, storage, responsive layouts, CORS and browser-specific permissions before public release.
