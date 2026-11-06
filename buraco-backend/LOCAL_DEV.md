# Running the backend on your PC (local testing)

Local copy of the backend for testing before anything goes to the live server.
It uses its own empty database — nothing here touches live players.

## First time only

```bash
cd /e/buraco--backend/buraco-backend
npm ci                                   # install packages (node_modules, never committed)
cp .env.example .env                     # then put long random values in the *_SECRET lines
docker compose -p buraco-local up -d postgres redis
npx prisma generate
npx prisma migrate deploy
npx prisma db seed                       # admin account, missions, shop items, system config
```

## Every day

1. Open **Docker Desktop**.
2. Start the database and Redis:
   ```bash
   cd /e/buraco--backend/buraco-backend && docker compose -p buraco-local up -d postgres redis
   ```
3. Start the API (reloads on code changes):
   ```bash
   npm run start:dev
   ```
4. API docs: http://localhost:3000/
5. In Unity: **Tools → Server → Local (this PC)**. Switch back to **Live** before making a release build.

Testing on a phone: phone and PC on the same Wi-Fi, then in Unity
**Tools → Server → Select Settings Asset** → set **Local Url** to `http://<PC Wi-Fi IP>:3000/`
(find the IP with `ipconfig`). Windows Firewall may ask to allow Node.js — allow on private networks.

## Stop

- API: `Ctrl + C` in its terminal.
- Database and Redis: `docker compose -p buraco-local stop`
  (data is kept; `stop`, never `down -v`, unless you want to wipe the local database).

## Checks

```bash
npm run build        # compiles
npx jest             # unit tests (104 passing at the start of Milestone 1)
```

## Local test accounts

- Admin panel: the super admin created by `prisma/seed.ts` (see that file).
- Game: `local.tester1@example.test` / `Test@12345` — local database only.
- Game, second player: `local.tester2@example.test` / `Test@12345` — local database only.

## Rules

- `.env` here is **local only**. Never copy it to the live server, never commit it.
- Deploying to the live server: follow `DEPLOY.md` (backup, new folder, switch, rollback).
- `DEBUG_GAME_EVENTS=true` in this local `.env` keeps the QA "force round" event working
  here; it is off on any server that does not set it.
