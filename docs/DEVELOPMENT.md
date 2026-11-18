# Local development

## Requirements
- Node.js 24.x and npm
- Docker Desktop
- Android Studio with Android SDK, or an Android phone with USB debugging
- Git

## First-time setup
~~~bash
git clone https://github.com/WilberAsingwire/NavigoUg.git
cd NavigoUg
npm install
~~~

Copy the API environment template:

~~~bash
cp apps/api/.env.example apps/api/.env
~~~

On Windows PowerShell:

~~~powershell
Copy-Item apps/api/.env.example apps/api/.env
~~~

Start PostgreSQL:

~~~bash
docker compose up -d db
~~~

When the Prisma schema milestone is ready, generate the client and create a development migration:

~~~bash
npm run db:generate
npm run db:migrate -- --name init
~~~

Build shared contracts before running the API:

~~~bash
npm run build:shared
npm run dev:api
~~~

Start the Android app in another terminal:

~~~bash
npm run dev:mobile
~~~

For a physical phone, make sure it can reach the development computer on the same network. Configure the API base URL in the app using the computer's LAN IP address, not localhost.

## Expo native module check
~~~bash
cd apps/mobile
npx expo install --fix
npx expo-doctor
~~~

A development build is required for background location and remote push notification testing on Android. Expo Go is not sufficient for these native capabilities.

## API smoke test
After the API starts:

~~~bash
curl http://localhost:4000/api/v1/health/live
~~~

The response should include status "ok" and service "navigo-api".

## Useful commands
~~~bash
npm run typecheck
npm run test:api
npm run build:api
docker compose logs -f db
docker compose down
~~~

Use synthetic test accounts and test phone numbers during development; do not use real participant details in early testing.
