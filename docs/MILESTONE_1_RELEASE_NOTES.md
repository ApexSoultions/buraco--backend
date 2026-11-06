# Milestone 1 — Backend Foundation: release notes

Branch `Taimoor_Updated_Backend`, commits `222401e` … `72bd3f2` on top of `83e62ef`.
Also ships the old developer's 30 Aug gameplay fixes (`83e62ef`), which were never
deployed: the live server runs the 20 Aug version.

## What changed for players

| Area | Before | Now |
|---|---|---|
| Chat | Messages were saved but never arrived live; anyone could post into any chat | Live delivery; start a private chat; members only; 1000-character and spam limits |
| Voice messages | Permanent public links; a 3.4 s clip failed to save | Private files, links valid 1 hour; checked before upload; max 2 minutes |
| Notifications | Only admin broadcasts existed, and only in the list | Live for friend requests/accepts, club events, mission rewards, club level-ups, admin broadcasts |
| Missions | Never moved; same 3 missions for everyone; reward could be claimed twice | Move after every match, chat message and club join; random from the pool; paid once |
| Clubs | No points from matches; club chat refused everyone; delete failed; join twice counted twice; a leader could set points/level | Points from matches, correct levels with level-up notice, working club chat, delete, handover, permissions |
| Rankings | Classic and International were the same list; page 2+ always empty | Classic = Classic-mode points, International = wins in all modes; paging works |
| Resign | `POST /game/{id}/resign` (called by the client) did not exist | Exists; same result as leaving over the socket; no double payout |
| Security | No rate limits at all; QA "force round" cheat on by default; hidden malicious code in the admin panel config | Per-player rate limits, login guessing blocked, chat spam capped; cheat off by default; malicious code removed; server refuses weak secrets in production |

## Database

One additive migration: `20261104120000_add_classic_points` (new `player_stats.classicPoints`
column, filled from past Classic wins). Nothing removed or renamed; the old version keeps
working on a migrated database.

## Server settings (`.env`) for the live server

- `NODE_ENV=production`
- `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_JWT_SECRET`: three different random values,
  32+ characters (all players log in again once)
- `DEBUG_GAME_EVENTS=false`
- Optional, defaults shown: `SWAGGER_ENABLED=true`, `THROTTLE_LIMIT=100`,
  `THROTTLE_ANON_LIMIT=60`, `THROTTLE_CHAT_PER_10S=10`

## Rules chosen pending the client's confirmation

- Club points: a club gains the ranking points its member earned in a match; 1000 points
  per club level.
- International ranking: total wins across all modes (as the API docs described).
- Voice messages: max 2 minutes. Chat: max 1000 characters, 10 messages per 10 seconds.

## Verification

- 209 automated tests (19 suites, gameplay included) pass on a clean clone of the branch.
- Each task was checked live against a local backend with two or more connected players.
- Scan of the branch: no secrets or `.env` files committed, no hidden/obfuscated code.

## Deploy

Follow `buraco-backend/DEPLOY.md` (backup → build alongside → settings → migration →
spare-port check → switch → rollback ready). Additional checks for this release:

1. After the switch, the log shows `Rankings rebuilt from player_stats` once.
2. A real voice message upload and playback works (needs the live AWS keys).
3. `GET /v1/game/active` right after a match starts (seen returning nothing for a player
   who has not joined the game socket yet; confirm the Unity flow is unaffected).
4. Watch for HTTP 429 in the client logs; raise `THROTTLE_LIMIT` if the client polls hard.

## Not in Milestone 1

Phone push notifications (needs Firebase from the client), the Clean/Dirty Buraco
detection fix from the old `Testing_Issues` branch, and the never-run quick-match queue
processor.
