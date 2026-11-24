# Live deploy: server update + admin panel (task 14)

Written 2026-11-24. One deploy that puts the new server and the admin panel on Live.
**You run every command; Claude never touches the server.** Do the steps in order and stop at
any step whose check fails (the "Check" line under each). Nothing here deletes the database or
the old server folder.

- **Time:** about 45–60 minutes. **Downtime:** a few seconds, at Step 6 only.
- **When:** when nobody is in a match (two server versions would both run the turn timer).
- **Decisions (2026-11-24):** keep the current IP `13.232.172.199` (no Elastic IP yet);
  JWT secrets are **not** replaced in this deploy.
- **Code:** branch `Taimoor_Updated_Backend` of `ApexSoultions/buraco--backend`
  (folders `buraco-backend` = game server, `buraco-admin` = panel, `deploy` = Caddy / pm2 files).
- **Panel address:** `https://admin.13-232-172-199.sslip.io`
- Background and rollback of the game server: `buraco-backend/DEPLOY.md`.

What this adds to Live: the server changes since Global Chat, two database migrations
(`report_review`, `support_tickets`; both only add), the admin panel (pm2 process
`buraco-admin`, port 3100, local only) and Caddy (HTTPS on ports 80 / 443).

---

## Step 0 · Before you start (on the PC)

- [ ] Both repos are pushed (done 2026-11-24: backend `0cac36d`).
- [ ] SSH works: `ssh -i /e/keys/buraco-new ubuntu@13.232.172.199` (then `exit`).
- [ ] AWS console access to the "buraco" instance (region Mumbai).
- [ ] You have chosen the first admin's **email** and a **password of 12+ characters** (you type
      it hidden on the server; it is never saved in a file or the shell history).

## Step 1 · AWS: open ports 80 and 443

Caddy needs port 80 once to get the HTTPS certificate, and 443 for the panel.

1. AWS console → **EC2 → Instances** → select **buraco** → tab **Security** → click the
   **security group** name.
2. **Edit inbound rules → Add rule**, twice:
   - Type **HTTP**, port 80, source **Anywhere-IPv4** (`0.0.0.0/0`)
   - Type **HTTPS**, port 443, source **Anywhere-IPv4** (`0.0.0.0/0`)
3. **Save rules.** Do not change the other rules (22 and 3000 stay as they are).

Check: both rules are listed.

## Step 2 · Back up (database + settings)

```bash
ssh -i /e/keys/buraco-new ubuntu@13.232.172.199
mkdir -p ~/backups
docker exec buraco_postgres pg_dumpall -U postgres | gzip > ~/backups/db-$(date +%F-%H%M).sql.gz
cp ~/buraco-backend/.env ~/backups/env-$(date +%F-%H%M).bak
ls -lh ~/backups
```

Check: a new `db-…sql.gz` that is not tiny (megabytes) and a new `env-…bak`.
Copy them to the PC (Git Bash on the PC, a second window): 

```bash
scp -i /e/keys/buraco-new "ubuntu@13.232.172.199:~/backups/*" /e/server-backups/
```

## Step 3 · Get the new code and build the game server (old one keeps running)

Still on the server:

```bash
rm -rf ~/release && git clone --depth 1 --branch Taimoor_Updated_Backend https://github.com/ApexSoultions/buraco--backend.git ~/release
rm -rf ~/buraco-backend-new && cp -a ~/release/buraco-backend ~/buraco-backend-new
cp ~/buraco-backend/.env ~/buraco-backend-new/.env
cd ~/buraco-backend-new && npm ci && npx prisma generate && NODE_OPTIONS=--max-old-space-size=1536 npm run build && ls dist/src/main.js
```

Check: the last line prints `dist/src/main.js`. (If the build says "heap out of memory", the old
server is untouched; run it again, it often passes the second time with swap warm.)

**Settings file.** `~/buraco-backend-new/.env` is the copy of the live one. Check these three
lines (no other change is needed; the secrets stay as they are):

```bash
grep -E "^(NODE_ENV|GOOGLE_PLAY_PACKAGE_NAME|ADMIN_JWT_SECRET)=" ~/buraco-backend-new/.env | sed 's/ADMIN_JWT_SECRET=.*/ADMIN_JWT_SECRET=(set)/'
```

- `NODE_ENV=production` must be there.
- `ADMIN_JWT_SECRET` must be there (the server refuses to start without it).
- `GOOGLE_PLAY_PACKAGE_NAME` should be `app.warag`. If it is missing or different:
  `sed -i 's/^GOOGLE_PLAY_PACKAGE_NAME=.*/GOOGLE_PLAY_PACKAGE_NAME=app.warag/' ~/buraco-backend-new/.env`
  (or add the line if there is none).

## Step 4 · Database migrations

```bash
diff <(ls ~/buraco-backend/prisma/migrations) <(ls ~/buraco-backend-new/prisma/migrations)
```

Expected: the new folders `20261122121240_report_review` and `20261124131046_support_tickets`
(and possibly others from earlier work). Then, after the backup in Step 2:

```bash
cd ~/buraco-backend-new && npx prisma migrate deploy
```

Check: it ends with "All migrations have been successfully applied." Both migrations only add
tables / columns, so the old server keeps working on the migrated database.

Default content (adds anything missing, never changes admins; safe to repeat):

```bash
cd ~/buraco-backend-new && NODE_ENV=production npx ts-node --transpile-only prisma/seed.ts --content
```

## Step 5 · Try the new game server on port 3001

```bash
cd ~/buraco-backend-new && PORT=3001 node dist/src/main.js
```

In a **second** SSH window:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/v1/admin/audit-logs
```

Check: `200`, then `401` (the new admin routes exist but need a login). Then `Ctrl+C` in the
first window.

## Step 6 · Switch the game server (a few seconds of downtime)

```bash
cd ~ && mv ~/buraco-backend ~/buraco-backend-old && mv ~/buraco-backend-new ~/buraco-backend && pm2 restart buraco-api
pm2 list && pm2 logs buraco-api --lines 40 --nostream
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```

Check: `buraco-api` is `online` and the curl prints `200`. Open the game once on your phone and
log in. If anything is wrong → **Rollback A** (end of this file).

```bash
pm2 save
```

## Step 7 · Build and start the admin panel (local only for now)

The panel needs Node **20.9 or newer**. Check first: `node -v`. (The game server already runs
on Node 20; if it prints something older than v20.9, stop here and tell Claude.)

```bash
cd ~ && rm -rf ~/buraco-admin-new && cp -a ~/release/buraco-admin ~/buraco-admin-new
cd ~/buraco-admin-new && npm ci && API_URL=http://localhost:3000 NODE_OPTIONS=--max-old-space-size=1536 npm run build && ls .next/BUILD_ID
```

`API_URL` is baked into the build: the panel talks to the game server on this same machine.

Check: the last line prints `.next/BUILD_ID`.

> If the build stops with "heap out of memory": the server is too small to build it. Build on
> the PC instead and upload it (tell Claude; this is the fallback, nothing on Live has changed).

Start it with pm2:

```bash
mv ~/buraco-admin-new ~/buraco-admin
cp ~/release/deploy/ecosystem.admin.config.js ~/ecosystem.admin.config.js
pm2 start ~/ecosystem.admin.config.js && pm2 save
sleep 5 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/login
free -m
```

Check: `buraco-admin` is `online`, the curl prints `200`, and `free -m` still shows some free
memory plus swap that is not full. The panel listens on `127.0.0.1` only, so it is **not**
reachable from the internet yet.

## Step 8 · Caddy (HTTPS)

First make sure nothing else uses ports 80 / 443 (the output must be empty):

```bash
sudo ss -ltnp | grep -E ':(80|443)\s'
```

Install Caddy (official packages):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Use the panel's address:

```bash
sudo cp ~/release/deploy/Caddyfile /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sleep 10 && sudo journalctl -u caddy -n 25 --no-pager
```

Check: `validate` says "Valid configuration" and the log shows the certificate was obtained
("certificate obtained successfully"). From the PC:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://admin.13-232-172-199.sslip.io/login
```

→ `200`. (If the certificate fails: ports 80 / 443 are not open in AWS (Step 1), or something
else uses them. Nothing else is affected.)

## Step 9 · First admin (hidden password)

On the server:

```bash
docker exec buraco_postgres psql -U postgres -d buraco_db -c "select email, role, \"isActive\", \"lastLoginAt\" from admin_users;"
```

This lists the staff accounts that already exist on Live. Then create yours:

```bash
cd ~/buraco-backend && npx ts-node prisma/create-admin.ts
```

It asks for: email, name, role (**SUPER_ADMIN**) and the password twice (hidden).

**Old accounts:** if the list above shows `admin@buraco.game` (or anyone you do not recognise),
the old seed gave that account a password that is visible in the repo history. After you can
log in (Step 10), deactivate it on the panel's **Admins** page (or, on the server:
`docker exec buraco_postgres psql -U postgres -d buraco_db -c "update admin_users set \"isActive\"=false where email='admin@buraco.game';"`).

## Step 10 · Check it works

1. Open `https://admin.13-232-172-199.sslip.io` (padlock shown), log in with your admin.
2. The Dashboard shows real numbers (players, matches).
3. Open **Audit log**: the first entry is your login ("Logged in").
4. **Admins** page: deactivate the old account if there is one (Step 9).
5. **Support**, **Clans**, **Shop** open without errors.

This is the start of task 15 (test every page on Live and the hand-over notes).

---

## Rollbacks

**A · Game server** (seconds; the database does not need restoring, migrations only add):

```bash
cd ~ && mv ~/buraco-backend ~/buraco-backend-failed && mv ~/buraco-backend-old ~/buraco-backend && pm2 restart buraco-api
```

**B · Panel and HTTPS** (the game is not affected):

```bash
pm2 delete buraco-admin && pm2 save
sudo systemctl stop caddy && sudo systemctl disable caddy
```

Then remove the two inbound rules (80, 443) in AWS if you want the ports closed.

## Updating the panel later

Same pattern as the game server: build the new copy next to the old one
(`~/buraco-admin-new`), then `mv ~/buraco-admin ~/buraco-admin-old && mv ~/buraco-admin-new ~/buraco-admin && pm2 restart buraco-admin`.
The old copy is the rollback.

## Things to know

- If the server's IP ever changes (stop / start without an Elastic IP), the game **and** the
  panel move: change the IP in `/etc/caddy/Caddyfile` (dots become dashes) and reload Caddy.
  An Elastic IP (release hardening) prevents this.
- The panel and the game server share the small server (about 900 MB). Watch `free -m` for a few
  days. pm2 restarts the panel by itself if it passes 300 MB.
- Admin login is limited to 5 tries per minute per computer by the game server.
- Old "game setting changed" entries in the audit log may hold secret values in the database
  (they are hidden on screen only). After a backup, clear them once:
  `docker exec buraco_postgres psql -U postgres -d buraco_db -c "update admin_audit_logs set details = '{}' where action = 'UPDATE_CONFIG';"`
