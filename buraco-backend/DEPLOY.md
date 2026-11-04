# Backend deployment runbook

How the live server is set up, and how to update it safely with a rollback ready.
Checked against the live server on 2026-11-03.

## The live server

| | |
|---|---|
| **Public IP** | `13.232.172.199` (port 3000; the Unity client's Live URL) |
| **AWS** | EC2 `i-0f0d4cb7081a66846` ("buraco"), region `ap-south-1` (Mumbai) |
| **OS / user** | Ubuntu 26.04, user `ubuntu` |
| **SSH** | `ssh -i /e/keys/buraco-new ubuntu@13.232.172.199` (key kept off git) |
| **API** | Node 20 run by **PM2** as `buraco-api` → `/home/ubuntu/buraco-backend/dist/src/main.js` |
| **Database / Redis** | Docker containers `buraco_postgres` (db `buraco_db`) and `buraco_redis` |
| **Settings** | `/home/ubuntu/buraco-backend/.env` (never in git) |
| **Backups** | `/home/ubuntu/backups/` on the server, copies in `E:\server-backups` |

PM2 restarts the API on reboot (`pm2-ubuntu.service`). The API is **not** a Docker
container on this server; only Postgres and Redis are.

**Never:**
- `docker compose down -v` — the `-v` deletes the database volume.
- delete or overwrite `~/buraco-backend` before a copy exists — that folder is the rollback.
- run anything that touches `buraco_postgres` / `buraco_redis` except the backup and
  `prisma migrate deploy` below.

The old `deploy.sh` deleted `~/buraco-backend` before uploading (no rollback) and targeted
an old IP; it was removed. Use the steps below.

---

## Update the server

Code comes from GitHub `ApexSoultions/buraco--backend` (the backend is the
`buraco-backend` folder inside it). Replace `BRANCH` below.

### 1. Back up (database + settings)

```bash
ssh -i /e/keys/buraco-new ubuntu@13.232.172.199
mkdir -p ~/backups
docker exec buraco_postgres pg_dumpall -U postgres | gzip > ~/backups/db-$(date +%F-%H%M).sql.gz
cp ~/buraco-backend/.env ~/backups/env-$(date +%F-%H%M).bak
pm2 save && ls -lh ~/backups
exit
```

Copy them to the PC (Git Bash on the PC):

```bash
scp -i /e/keys/buraco-new "ubuntu@13.232.172.199:~/backups/*" /e/server-backups/
```

### 2. Build the new version next to the old one

Players keep using the old version on port 3000 throughout.

```bash
ssh -i /e/keys/buraco-new ubuntu@13.232.172.199
rm -rf ~/release && git clone --depth 1 --branch BRANCH https://github.com/ApexSoultions/buraco--backend.git ~/release
rm -rf ~/buraco-backend-new && cp -a ~/release/buraco-backend ~/buraco-backend-new
cp ~/buraco-backend/.env ~/buraco-backend-new/.env
cd ~/buraco-backend-new && npm ci && npx prisma generate && npm run build && ls dist/src/main.js
```

### 3. Check the settings file

Compare `~/buraco-backend-new/.env` with `.env.example` and add anything new. Required on
the live server:

- `NODE_ENV=production`
- `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_JWT_SECRET`: three **different** random
  values, 32+ characters. In production the server **refuses to start** otherwise.
  Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
  New values log every player out once.
- `DEBUG_GAME_EVENTS=false`
- `AWS_*` set (voice messages and avatars)

### 4. Database migrations (only if there are new ones)

```bash
diff <(ls ~/buraco-backend/prisma/migrations) <(ls ~/buraco-backend-new/prisma/migrations)
```

Nothing printed → skip. New folders listed → after the backup in step 1:

```bash
cd ~/buraco-backend-new && npx prisma migrate deploy
```

Migrations here only add; the old version keeps working on the migrated database.

### 5. Try the new version on a spare port first

Only when **no match is in progress** (both versions would run the turn timer otherwise).

```bash
cd ~/buraco-backend-new && PORT=3001 node dist/src/main.js
```

In a second SSH window: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/`
→ `200`. Point a test client at port 3001 if needed. Stop it with `Ctrl+C`.

### 6. Switch (a few seconds of downtime)

```bash
cd ~ && mv ~/buraco-backend ~/buraco-backend-old && mv ~/buraco-backend-new ~/buraco-backend && pm2 restart buraco-api
pm2 list && pm2 logs buraco-api --lines 40 --nostream
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```

`online` and `200` → test the game. When happy: `pm2 save`.
Keep `~/buraco-backend-old` for a few days, then delete it.

### Rollback (seconds)

```bash
cd ~ && mv ~/buraco-backend ~/buraco-backend-failed && mv ~/buraco-backend-old ~/buraco-backend && pm2 restart buraco-api
```

The database rarely needs restoring (migrations only add). If it ever does, restore
from `~/backups/db-….sql.gz` — plan that step before running it.

---

## Everyday commands (on the server)

```bash
pm2 list                                  # is the API online?
pm2 logs buraco-api --lines 100           # recent logs
pm2 restart buraco-api                    # restart the API only
docker ps                                 # Postgres / Redis status
df -h / && free -m                        # disk / memory
ls -lh ~/backups                          # backups on the server
```

## Before the public release

- **HTTPS**: a domain pointed at this IP, nginx + Let's Encrypt in front of port 3000.
  The API already trusts `X-Forwarded-For` from a local proxy, so rate limits keep
  working behind nginx.
- **Elastic IP**, so the public IP survives an instance stop/start.
- **Close ports 5432 and 6379** in the security group (Postgres/Redis are published on
  `0.0.0.0` by Docker; only the API on 3000 and SSH on 22 need to be reachable).
- `SWAGGER_ENABLED=false` to hide the API docs page.
- Scheduled database backups.
