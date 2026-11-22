# WARAGA Admin Panel — plan

Started 2026-11-22. Milestone 6, task 1–2.

## What it is
- A **website** for the game's staff (not players): open it in any browser, log in with an
  admin account, manage the game.
- Code: `buraco-admin/` in this repo (Next.js + React + Tailwind; ~3,000 lines, ~10 pages).
- It talks to the same game server: the website calls `/api/v1/...`, which is passed on to the
  game server's `/v1/admin/...` routes. Admins log in with their own accounts (`AdminUser`
  table) and a separate key (`ADMIN_JWT_SECRET`); player accounts can't open it.
- Roles already in the server: **SUPER_ADMIN** (everything), **MODERATOR** (players, reports,
  clans, chat), **SUPPORT** (read players, support tickets, notes).
- Address (chosen 2026-11-22): **`https://admin.13-232-172-199.sslip.io`** — sslip.io is a free
  service that points any name containing an IP at that IP (no account). Caddy on the server
  gets a free Let's Encrypt certificate for it (HTTPS) and sends it to the panel (pm2). Needs:
  ports 80/443 open in the AWS security group and an **Elastic IP** (if the IP changes, the
  address changes). When the client has a domain, only the Caddy line changes
  (e.g. `admin.warag.app`). Never plain-HTTP on the internet.
- Look: a clean dashboard (dark side menu, white content, tables, forms), the game logo, works
  on a laptop and a phone. No Figma frame exists for it.

## Tasks
| # | Task | Status |
|---|------|--------|
| 1 | **Security check** of the whole admin app (its history had malicious code removed twice): read every file, dependencies, config; `npm audit`; fix anything found | ✅ 2026-11-22: no hidden code or leftovers; 10 vulnerable packages updated (Next 16.4.6, axios, js-cookie…), 0 left; login cookie strict + HTTPS-only; panel can't be framed |
| 2 | **Login and roles**: admin login works against the current server; menu shows only what the role may use; change own password; a safe way to create the first admin (server command) | ✅ 2026-11-22: `GET /admin/me`, `PATCH /admin/auth/password`, `GET/POST/PATCH /admin/admins` (super admin; can't switch off / demote yourself; always one active super admin; audit-logged, passwords never logged); missions edits and audit log now super-admin only; panel: menu by role, "No access" page, My password, Admins page; `npx ts-node prisma/create-admin.ts` (hidden password). Tested locally: Support sees Dashboard/Users/Games/Leaderboard only, gets 403 on admins/missions/audit; a switched-off admin is logged out at once |
| 3 | **Layout**: side menu grouped (Players · Moderation · Economy · Content · Clans · System), top bar (who is logged in, log out), WARAGA logo, phone-friendly | ✅ 2026-11-22: dark grouped side menu (Overview · Players · Community · Economy · Content · System; new pages go in `components/layout/nav.ts`), top bar with page name + account menu (My password, Log out), WARAGA logo and tab icon, login page restyled, hidden from search engines; phones: menu is a slide-in drawer. Page headings renamed to match (Players, Matches, Clans, Game settings, Audit log) |
| 4 | **Dashboard**: players total / online now / new today, matches today, coins and purchases today, open reports, pending custom cards | ⬜ |
| 5 | **Players**: search, profile (level, coins, lives, items, clan, matches), ban / unban, give / take coins and lives, send an item, notes, reset name | ⬜ |
| 6 | **Moderation**: player and chat reports (private messages, table chat, global chat) with the reported message; resolve / dismiss / ban; clear global chat | ⬜ |
| 7 | **Custom cards**: pending uploads with the picture; approve / reject (reject refunds) — replaces the SQL command | ⬜ |
| 8 | **Economy**: shop items and prices (incl. restoring real prices after testing), redeem / promo codes, real-money purchases list (Google Play / App Store) | ⬜ |
| 9 | **Content**: missions, achievements, clan objectives, level table | ⬜ |
| 10 | **Clans**: list, details, members, remove member, delete clan | ⬜ |
| 11 | **Messages to players**: broadcast to everyone (in-game notification); game settings (system config) | ⬜ |
| 12 | **Support**: the in-game "Contact Game Support" form (Figma frame exists) + tickets list in the panel with reply / close | ⬜ |
| 13 | **Audit log**: every admin action, who / when / what | ⬜ (page exists; check) |
| 14 | **Deploy on Live**: run the panel on the server (pm2), web server with HTTPS for `admin.<domain>`, login rate limit; step-by-step commands for the user | ⬜ |
| 15 | **Test and hand-over notes**: every page against a local server, then Live; how to add admins | ⬜ |

## Needs from the client
- The **domain** for the admin address (e.g. `admin.warag.app`) pointed at the server's IP.
- Who uses the panel and with which role (owner = SUPER_ADMIN; support staff = SUPPORT, …).

## Rules
- Server changes: tests (`npx jest`) and `npx tsc --noEmit` must pass; new tables additive only.
- Never print or commit secrets; the user runs the Live commands.
