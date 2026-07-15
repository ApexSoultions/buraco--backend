# Local Setup Guide for Buraco Backend

This guide provides step-by-step instructions for setting up the Buraco backend locally on your Windows machine, specifically tailored for Unity development and integration testing.

## 1. Prerequisites (Required Software)
To run this backend locally, you must install the following software on your Windows machine:
1. **Node.js**: Version 20 is required. Download the LTS version from nodejs.org.
2. **Git**: To version control and pull the latest code.
3. **Docker Desktop**: Required to run PostgreSQL and Redis cleanly without installing them directly on Windows. Make sure Docker Engine is running.

## 2. Environment-Variable Setup
1. Open the `buraco-backend` folder.
2. Rename the generated `.env.example.local` file to `.env` (or copy its contents into a new file named `.env`).
3. This `.env` file contains safe development dummy values for integrations like AWS S3, Apple, and Google. The backend will start successfully with these dummy values, allowing you to test core Unity flows without needing real production secrets.

## 3. Installation Steps
Open your terminal (PowerShell or Command Prompt) and run the following commands:

```bash
cd buraco-backend
npm ci
```
*Note: We use `npm ci` instead of `npm install` to strictly respect the `package-lock.json` and prevent accidental package upgrades.*

## 4. Docker, PostgreSQL, and Redis Setup
Start the mandatory database and cache services using Docker Compose:

```bash
docker compose up -d postgres redis
```
This starts:
- **PostgreSQL**: Port `5432` (User: `postgres`, Password: `postgres`, DB: `buraco_db`)
- **Redis**: Port `6379`

## 5. Prisma Commands (Database Structure Setup)
Once the databases are running, initialize the schema:

```bash
npx prisma generate
npx prisma migrate dev
```
*(If `migrate dev` fails due to no existing migration history, use `npx prisma db push` to safely sync the schema to the empty database).*

If there is a seed script, populate initial data:
```bash
npm run seed
```

## 6. Backend Start Command
Start the NestJS backend (the server-side manager):

```bash
npm run start:dev
```
The backend will boot up and establish connections to PostgreSQL and Redis.

## 7. Admin-Panel Start Command (Optional)
If you also want to run the admin dashboard locally:
1. Open a *new* terminal window.
2. Navigate to the admin folder: `cd buraco-admin`
3. Install dependencies: `npm ci`
4. Start the dashboard: `npm run dev`

## 8. Local URLs
- **REST API URL**: `http://localhost:3000/v1`
- **Swagger URL (API Docs)**: `http://localhost:3000/` *(Note: The code binds it to the root, unlike the documentation which stated `/api/docs`)*
- **Socket.IO URL**: `http://localhost:3000`
- **Admin Panel URL**: `http://localhost:3001` (if running)

## 9. Test-Account Instructions
Since this is a fresh local database, you will need to register a dummy account:
1. Open your browser and go to `http://localhost:3000/` (Swagger).
2. Find the **Auth** > `/v1/auth/register` endpoint.
3. Provide dummy data (e.g., `email: "test@example.com"`, `username: "testuser"`, `password: "password123"`).
4. Execute it. This account will be created with default coins and lives as configured in `.env`.

## 10. Unity Connection Values (Phase 4)
Use these exact parameters in UnityWebRequest and your Unity Socket.IO client:

1. **Local REST Base URL**: `http://localhost:3000/v1`
2. **Local Socket.IO URL**: `http://localhost:3000`
3. **Socket.IO Namespace**: `/` (The default namespace)
4. **Socket.IO Path**: `/socket.io/` (The default path)
5. **JWT Handshake Format**: Pass the token in the auth payload when connecting. In C# (using most Unity Socket.IO packages):
   ```csharp
   options.Auth = new Dictionary<string, string> { { "token", "YOUR_JWT_ACCESS_TOKEN" } };
   ```
   *(Alternatively, it accepts `Authorization: Bearer <token>` in the ExtraHeaders).*
6. **Required Headers**: `Content-Type: application/json` for REST requests.
7. **Connection Acknowledgement Event**: Listen for the `"connect_ack"` event. It returns `{ userId, socketId }`.
8. **Heartbeat / Ping Event**: You can emit `"ping"` to the server. The server will reply with `"pong"` containing a timestamp.
9. **Android-Device URL**: If testing on an Android device connected to the same Wi-Fi, replace `localhost` with your PC's local IP address (e.g., `http://192.168.1.50:3000`).
10. **Windows Firewall**: If testing from Android/iOS, you must allow inbound traffic on TCP Port `3000`.

### Main Game & Room Events (RPCs)
- **Join Lobby/Room**: Emit `room:join` payload `{ roomId: "..." }`. Listen for `room:joined_ack` and `room:update`.
- **Matchmaking / Join Game**: Emit `game:join` payload `{ gameId: "..." }`.
- **Game Started**: Listen for `game:start_snapshot`, `game:deal_start`, `game:toss_result`.
- **Moves**: Emit `game:move:draw`, `game:move:discard`, `game:move:meld`.
- **Game State Updates**: Listen for `game:state_updated` (incremental move) or `game:state_sync` (full state).
- **Game End**: Listen for `game:end`.

## 11. Common Errors and Fixes
- **Port 5432 / 3000 already in use**: Another Postgres instance or web server is running on Windows. You must stop it before running `docker compose up` or `npm run start:dev`.
- **Prisma "Datasource URL must use postgresql://"**: Double-check your `.env` file exists and contains `DATABASE_URL`.
- **Session Superseded**: The server drops older Socket connections if you log in from a new Unity client with the same token.

## 12. Clean Shutdown Commands
When you are done testing, cleanly stop the backend:
1. In the backend terminal, press `Ctrl + C` to stop NestJS.
2. Stop the Docker containers: `docker compose stop`

## 13. Restart Instructions (Resetting the database)
If you need to wipe everything and start from scratch safely:
1. `docker compose down -v` *(Deletes the database and Redis volumes)*
2. `docker compose up -d`
3. `npx prisma db push`
4. `npm run seed`
5. `npm run start:dev`
