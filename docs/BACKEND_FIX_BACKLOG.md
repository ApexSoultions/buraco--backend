# Buraco Backend — Prioritized Fix Backlog

Derived from the senior audit vs `REQ (1).pdf` and QA notes in `Brasilian 8.docx`.  
Unity-only items are listed at the bottom for coordination, not backend implementation.

**Overall rules coverage:** ~85–90% of REQ is already in the NestJS engine.  
Priority is correctness, sync, and wiring — not missing major rule modules.

---

## P0 — Ship / play blockers

### 1. Wire matchmaking queue processor
| | |
|---|---|
| **Problem** | `MatchmakingService.processQueues()` exists but is never called. Players join Redis queues and sit forever. |
| **Files** | [`buraco-backend/src/modules/matchmaking/matchmaking.service.ts`](../buraco-backend/src/modules/matchmaking/matchmaking.service.ts), new cron (mirror game-engine’s `@Cron(EVERY_5_SECONDS)`), room creation after match |
| **Work** | Add cron (or scheduled poll) that calls `processQueues()`, creates a Room with matched players, deducts/settles fees correctly, emits `room:update` / match-found to selected userIds |
| **Done when** | Two (1v1) or four (2v2) queued clients receive a room/game and can start; leave-queue still refunds |

### 2. Fix clean / dirty Buraco client contract (`isNatural`)
| | |
|---|---|
| **Problem** | Every `2` is built with `isWild: true` in [`deck.ts`](../buraco-backend/src/modules/game-engine/buraco/deck.ts). Melds set `isNatural: cards.every(c => !c.isWild)`, so any natural-2 run (e.g. A–7 or 2–8 same suit) is labeled non-natural. Scoring already uses `computeMeldHasActingWild` (clean = 200). QA sees Dirty UI for Clean Buraco. |
| **Files** | [`game-engine.service.ts`](../buraco-backend/src/modules/game-engine/game-engine.service.ts) (all `isNatural:` assignments ~584, ~620, ~1855), optionally expose `buracoKind: 'CLEAN' \| 'SEMI_CLEAN' \| 'DIRTY' \| null` from scoring helpers |
| **Work** | Set `isNatural` from `!computeMeldHasActingWild(...)` (and Pro `everDirty`). Optionally add explicit `buracoKind` on meld payload for Unity |
| **Done when** | State sync for `A,2,3,4,5,6,7` and `2,3,4,5,6,7,8` same suit reports clean; score bonus 200 |

### 3. Google Sign-In server error (QA #1)
| | |
|---|---|
| **Problem** | `loginWithGoogle` verifies ID token against `google_client_id` / env. Wrong or empty audience → 401/500 on client. |
| **Files** | [`auth.service.ts`](../buraco-backend/src/modules/auth/auth.service.ts), system config / `.env`, Unity Google client ID must match server audience (Web + Android/iOS as needed) |
| **Work** | Confirm configured audience list; return clear 401 (not opaque 500); document required Unity client IDs in LOCAL_SETUP |
| **Done when** | Google login succeeds against local + staging with documented client IDs |

---

## P1 — Correctness / multiplayer stability

### 4. Re-verify 12-AFK forfeit always ends the **match** (QA #12–13)
| | |
|---|---|
| **Problem** | Code comments claim forfeit ends match (not round) and counters persist across rounds. QA previously saw round-only end. |
| **Files** | [`game-engine.service.ts`](../buraco-backend/src/modules/game-engine/game-engine.service.ts) — `checkAndForfeit`, `forfeitPlayer`, `finalizeGame`, round-reset paths |
| **Work** | Manual + automated test: multi-round with continuous autoplay → match COMPLETED by 12th miss; single-hand same |
| **Done when** | Regression test (or scripted session) proves match end; no `game:new_round` after forfeit |

### 5. Dual-device desync: “player left” vs still playing (QA #4, #9, #11)
| | |
|---|---|
| **Problem** | One client gets terminal leave/forfeit UI while the other keeps playing; reconnect into ended game |
| **Files** | Gateway disconnect/reconnect, `forfeitPlayer` / `finalizeGame` broadcast, [`reconnection.service.ts`](../buraco-backend/src/modules/reconnection/reconnection.service.ts) |
| **Work** | Ensure single authoritative end event (`game:end`) to all seats; reconnect of finished match always returns terminal payload (never mid-game sync); harden NX locks already present |
| **Done when** | Reproduce disconnect + AFK paths; both devices show same end reason and scoreboard |

### 6. Toss missing on first join (QA #5)
| | |
|---|---|
| **Problem** | Toss emits before one client subscribed to `game:{id}` |
| **Files** | [`gateway.ts`](../buraco-backend/src/websocket/gateway.ts), start-game flow in rooms / engine |
| **Work** | Delay toss until all seats `game:join`, or replay `game:toss_result` on `game:join` / snapshot |
| **Done when** | Both devices always see toss on cold start |

### 7. Scoreboard out of sync after leave mid multi-round (QA #10)
| | |
|---|---|
| **Problem** | Leave / resign path may send incomplete round breakdown |
| **Files** | Resign / leave / forfeit score builders in `game-engine.service.ts` |
| **Work** | Reuse same `buildRoundScoreBreakdown` for resign, forfeit, and normal finalize; include `matchScores` + `targetScore` on every end payload |
| **Done when** | Both clients show identical numbers after any leave path |

---

## P2 — Hardening & docs

### 8. Apple Sign-In: verify JWT with Apple JWKS
| | |
|---|---|
| **Problem** | Current flow base64-decodes payload only (spoofable). |
| **Files** | `auth.service.ts` Apple path |
| **Work** | Verify `id_token` signature against Apple keys; check `aud` / `iss` / expiry |
| **Done when** | Invalid tokens rejected; valid Apple tokens create/login user |

### 9. Classic run `3,2,5,6` same suit (QA #3) — confirm server
| | |
|---|---|
| **Problem** | QA cannot play Pinella as gap wild. Engine Classic path should already allow via `isValidRun(naturals, 1)`. |
| **Files** | [`rules.ts`](../buraco-backend/src/modules/game-engine/buraco/rules.ts) + unit tests |
| **Work** | Add unit test; if fail, fix validator. If pass, file as Unity client validation bug |
| **Done when** | Automated test green; Unity ticket only if backend passes |

### 10. 75-rule visibility (QA #14)
| | |
|---|---|
| **Problem** | Server tracks `seventyFiveRule`; table UI `0/75` / popup missing |
| **Files** | Ensure field in `game:state_updated` / `game:state_sync` player view; Unity binds it |
| **Work** | Confirm serialization; document event shape for client |
| **Done when** | Client can drive 0/75 UI from payload without guessing |

### 11. Update stale tech doc §19
| | |
|---|---|
| **Problem** | [`BACKEND_TECHNICAL_DOCUMENT.md`](../BACKEND_TECHNICAL_DOCUMENT.md) claims Multi-round, Direct, MAKART, Buraco of 2, natural-2 are missing — they are implemented |
| **Work** | Rewrite §18–19 to match code; point to this backlog for true gaps |
| **Done when** | Doc and code agree |

### 12. Engine unit / e2e tests
| | |
|---|---|
| **Problem** | Almost no coverage; meld/canastra/close/forfeit regressions return |
| **Work** | Tests for `validateMeld`, `computeMeldHasActingWild`, `buracBonus`, Classic/Pro close, Makart, forfeit-after-12 |
| **Done when** | CI runs suite on PRs |

### 13. Prod hardening
HTTPS/WSS, backups, Socket.IO adapter if multi-instance, rate limits already partially present.

---

## Unity-owned (out of this repo — track separately)

| QA | Issue |
|----|--------|
| #6 | AI discard animation gap / card spacing |
| #7 | Sudden return to home after toss |
| #8 | Deal animation from pot vs center deck |
| #11 (animation part) | Deck stuck mid-deal (server may then AFK-forfeit) |
| #14 (UI) | Popup and table `0/75` rendering |

---

## Suggested implementation order

1. P0.2 `isNatural` / buraco kind (small, unblocks Clean Buraco QA)  
2. P0.3 Google client ID / error handling  
3. P0.1 Matchmaking cron + room handoff  
4. P1.4–7 Sync / toss / forfeit / scoreboard  
5. P2 tests + Apple + doc refresh  

---

*Generated from project analysis. Do not treat `BACKEND_TECHNICAL_DOCUMENT.md` §19 as the source of truth for remaining work.*
