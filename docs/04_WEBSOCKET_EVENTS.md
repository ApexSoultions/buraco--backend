# WebSocket Events Reference

**Transport:** Socket.io  
**URL:** `wss://api.buraco.game/ws`  
**Auth:** Token passed on handshake (see Connection section)

---

## Connection

### Establishing Connection (Unity Client)

```javascript
// Unity → Server: connect with JWT
socket.connect({
  auth: {
    token: "eyJhbGc..."  // JWT access token
  }
})
```

The server validates the token on handshake. If invalid → connection refused with error `AUTH_FAILED`.

### Namespaces

| Namespace | Purpose |
|-----------|---------|
| `/` (default) | General: notifications, rooms, presence |
| `/game` | Active gameplay events |
| `/chat` | Messaging events |

---

## Connection Events

### CLIENT → SERVER

#### `ping`
Heartbeat to maintain connection.
```json
{}
```

### SERVER → CLIENT

#### `connect`
Fires when connection established.
```json
{
  "userId": "uuid",
  "socketId": "abc123"
}
```

#### `disconnect`
Fires on disconnection. Reason codes:
- `io server disconnect` — server kicked client
- `transport close` — network dropped
- `ping timeout` — heartbeat failed

#### `error`
Connection or auth error.
```json
{
  "code": "AUTH_FAILED",
  "message": "Invalid or expired token"
}
```

#### `pong`
Response to ping.
```json
{ "timestamp": 1704067200000 }
```

---

## Room Events

### CLIENT → SERVER

#### `room:subscribe`
Subscribe to live room list updates.
```json
{}
```

#### `room:unsubscribe`
Stop receiving room list updates.
```json
{}
```

#### `room:join`
Join a room via WebSocket (after REST call).
```json
{
  "roomId": "room-uuid"
}
```

#### `room:leave`
Leave a room via WebSocket.
```json
{
  "roomId": "room-uuid"
}
```

---

### SERVER → CLIENT

#### `room:list_update`
Broadcast to all subscribed clients when room list changes.
```json
{
  "event": "room:list_update",
  "data": {
    "action": "UPDATED",    // CREATED | UPDATED | DELETED
    "room": {
      "id": "room-uuid",
      "mode": "CLASSIC",
      "variant": "TWO_VS_TWO",
      "status": "WAITING",
      "currentPlayers": 3,
      "maxPlayers": 4,
      "players": [
        { "userId": "uuid", "username": "P1", "avatarUrl": "...", "level": 12 }
      ]
    }
  }
}
```

#### `room:player_joined`
Sent to players in the room when someone joins.
```json
{
  "event": "room:player_joined",
  "data": {
    "roomId": "room-uuid",
    "player": {
      "userId": "uuid",
      "username": "NewPlayer",
      "avatarUrl": "...",
      "level": 8
    },
    "currentPlayers": 3,
    "maxPlayers": 4
  }
}
```

#### `room:player_left`
Sent to players in the room when someone leaves.
```json
{
  "event": "room:player_left",
  "data": {
    "roomId": "room-uuid",
    "userId": "uuid",
    "username": "PlayerLeft",
    "currentPlayers": 2
  }
}
```

#### `room:ready`
Sent to all players in room when enough players joined and game is about to start.
```json
{
  "event": "room:ready",
  "data": {
    "roomId": "room-uuid",
    "gameStartsIn": 5,
    "players": [
      { "userId": "uuid", "username": "P1", "team": 1 },
      { "userId": "uuid2", "username": "P2", "team": 2 }
    ]
  }
}
```

---

## Matchmaking Events

### CLIENT → SERVER

#### `matchmaking:status`
Request current queue status.
```json
{}
```

### SERVER → CLIENT

#### `matchmaking:match_found`
Sent when matchmaking finds a game.
```json
{
  "event": "matchmaking:match_found",
  "data": {
    "roomId": "room-uuid",
    "gameMode": "CLASSIC",
    "variant": "ONE_VS_ONE",
    "opponent": {
      "userId": "uuid",
      "username": "Opponent",
      "avatarUrl": "...",
      "level": 10
    }
  }
}
```

#### `matchmaking:queue_update`
Queue position update.
```json
{
  "event": "matchmaking:queue_update",
  "data": {
    "position": 2,
    "estimatedWaitSeconds": 20
  }
}
```

---

## Gameplay Events

**Namespace:** `/game`  
All game events are scoped to a specific `gameId`.

### CLIENT → SERVER

#### `game:join`
Join the game channel on reconnect.
```json
{
  "gameId": "game-uuid"
}
```

#### `game:move:draw`
Draw a card.
```json
{
  "gameId": "game-uuid",
  "source": "STOCK"   // STOCK | DISCARD
}
```

#### `game:move:meld`
Play a meld from hand.
```json
{
  "gameId": "game-uuid",
  "cardIds": ["card-1", "card-2", "card-3"],
  "meldType": "SET"   // SET | SEQUENCE
}
```

#### `game:move:add_to_meld`
Add cards to an existing meld on the table.
```json
{
  "gameId": "game-uuid",
  "meldId": "meld-1",
  "cardIds": ["card-5"]
}
```

#### `game:move:discard`
Discard a card to end your turn.
```json
{
  "gameId": "game-uuid",
  "cardId": "card-7"
}
```

#### `game:move:pickup_pot`
Pick up the pot pile.
```json
{
  "gameId": "game-uuid"
}
```

#### `game:move:cancel_melds` (added 2026-08-03 — 75-rule rework)
Voluntarily gives up this turn's not-yet-satisfied 75-rule melds: their cards return to your
hand, `seventyFiveRequired` rises by 20, and your turn continues (you're still free to meld
again or discard). Only valid on your own turn, in `CAN_MELD_OR_DISCARD`, with something
actually pending — otherwise the server replies `game:move_invalid` with reason
`NOTHING_TO_CANCEL`.
```json
{
  "gameId": "game-uuid"
}
```
Response: a normal `game:state_updated` (see below), with `lastMove.type = "CANCEL_MELDS"`
and the rollback block described in [75-rule rollback in `lastMove`](#75-rule-rollback-in-lastmove).

#### `game:deal_complete` (added 2026-08-30 — deal gate)
Sent once this client has finished animating the cards onto the table, after a
`game:deal_start` (match start) or a `game:new_round` (every later round).
```json
{
  "gameId": "game-uuid"
}
```
The turn timer does not start until **every** seat has sent this — see
[Deal gate](#deal-gate--the-turn-timer-starts-after-dealing) below. Safe to send more than
once. A client that never sends it is not fatal: the server opens the gate on its own after
15 seconds, but the table then sits idle for that whole window, so send it.

#### `game:reconnect`
Sent on reconnect to request full state sync.
```json
{
  "gameId": "game-uuid"
}
```

---

### 75-rule fields (added 2026-08-03)

Every state payload the server sends you (`game:state_sync`, `game:state_updated`,
`game:new_round`, `game:deal_start`, etc. — anywhere the full game state is included) now
carries 4 fields describing **your own** 75-rule progress this round:

| Field | Meaning |
|-------|---------|
| `seventyFiveActive` | `true` once your team's cumulative match score has reached 1000 — the rule applies this round |
| `seventyFiveSatisfied` | `true` once you've met `seventyFiveRequired` this turn (or the rule is inactive) — permanent for the rest of the round |
| `seventyFiveRequired` | Current minimum point total for your opening meld. Starts at 75; +20 each time a `cancel_melds` (manual or automatic) fires |
| `seventyFiveTurnPoints` | Running total of THIS turn's not-yet-satisfied meld/add-to-meld plays — the "40" in "40/75" |

**Behaviour change from the old rule:** a below-threshold `game:move:meld` /
`game:move:add_to_meld` is no longer rejected. It's accepted and the cards stay on the
table — `seventyFiveTurnPoints` climbs with each play — until the running total reaches
`seventyFiveRequired`, at which point `seventyFiveSatisfied` flips to `true` and the melds
are locked in for good. Two ways it can end unsatisfied instead:
- The player calls `game:move:cancel_melds` (see above) — cards return to hand, `seventyFiveRequired += 20`.
- The player discards while still short — the backend auto-performs the same rollback
  (+20) before processing the discard, so a partial attempt never silently carries into
  the next turn. Discarding with no meld attempt at all this turn is NOT penalised.

#### Per-player 75-rule state (added 2026-08-05)

The four fields above are **viewer-scoped** — they describe the player the payload was built
for. A phone cannot label the *opponent's* 75-rule state from them, so the identical four
fields are also present on **every** entry of `players[]`:

```json
"players": [
  {
    "id": "playerA", "userId": "playerA", "teamId": 1, "seatIndex": 0,
    "score": 1020, "handCount": 11, "melds": [],
    "seventyFiveActive": true,
    "seventyFiveSatisfied": false,
    "seventyFiveRequired": 95,
    "seventyFiveTurnPoints": 0
  },
  {
    "id": "playerB", "userId": "playerB", "teamId": 2, "seatIndex": 1,
    "score": 870, "handCount": 11, "melds": [],
    "seventyFiveActive": false,
    "seventyFiveSatisfied": true,
    "seventyFiveRequired": 75,
    "seventyFiveTurnPoints": 0
  }
]
```

Render the "YOUR 75-RULE" / "OPP 75-RULE" label for a seat from that seat's `players[]`
entry — never from the root fields, which always describe the local player. Both phones
therefore show the same requirement for the same player.

`players[i].melds` and `players[i].handCount` are recomputed from the authoritative board on
every send, so a rolled-back card is gone from every meld array and back in the hand count
the moment the rollback happens — on both phones, in the same payload.

#### 75-rule rollback in `lastMove`

Whenever a pending attempt is rolled back — manually or automatically — `lastMove` carries
the exact rollback, and **every** viewer receives the identical block (the actor and the
opponent both need the ids to animate the cards back to that seat's hand):

| Field | Meaning |
|-------|---------|
| `playerId` | Seat that rolled back — resolve which screen seat to animate |
| `returnedCardIds` | The exact cards to fly from that seat's meld area back to its hand |
| `seventyFiveRequiredBefore` / `After` | e.g. `75` → `95`; `After` matches `players[i].seventyFiveRequired` in the same payload |
| `seventyFiveTurnPointsBefore` / `After` | e.g. `40` → `0` |
| `seq` | Post-move `moveCount`. Present on every `lastMove`; ignore a payload whose `seq` you have already applied instead of rebuilding the board again |

| Scenario | `lastMove.type` | Rollback block |
|----------|-----------------|----------------|
| Manual cancel | `CANCEL_MELDS` | always present (`cardIds` still mirrors `returnedCardIds`) |
| Discard with a pending short attempt | `DISCARD` | present, plus `autoCancelled75: true` and `discardedCardId` |
| Ordinary discard, nothing pending | `DISCARD` | absent, `autoCancelled75: false` |
| Server auto-played (AFK) turn end | `TIMEOUT_DISCARD` / `TIMEOUT_ADVANCE` | present + `autoCancelled75: true` when an attempt was open |
| Successful completion | `MELD` / `ADD_TO_MELD` | absent; `players[actor].seventyFiveSatisfied` flips to `true` |

The `+20` is applied exactly once, on the server, at the moment of the rollback. Every later
payload reports the already-updated `seventyFiveRequired` — re-rendering or replaying a
`state_updated` never re-applies it.

While the 75-rule is active and unsatisfied, the AFK auto-play AI is bound by the same
requirement: it opens only if what it can lay down that turn actually reaches
`seventyFiveRequired`, otherwise it melds nothing and just discards.

---

### SERVER → CLIENT

#### `game:start`
Game has started, sent to all players.
```json
{
  "event": "game:start",
  "data": {
    "gameId": "game-uuid",
    "mode": "CLASSIC",
    "variant": "TWO_VS_TWO",
    "myHand": [
      { "id": "card-1", "suit": "HEARTS", "rank": "ACE" },
      { "id": "card-2", "suit": "SPADES", "rank": "7" }
    ],
    "stockPileCount": 86,
    "discardTop": { "id": "card-x", "suit": "DIAMONDS", "rank": "3" },
    "potPiles": [
      { "index": 0, "count": 11 },
      { "index": 1, "count": 11 }
    ],
    "players": [
      { "userId": "uuid", "username": "Me", "handCount": 11, "team": 1 },
      { "userId": "uuid2", "username": "Partner", "handCount": 11, "team": 1 },
      { "userId": "uuid3", "username": "Opp1", "handCount": 11, "team": 2 },
      { "userId": "uuid4", "username": "Opp2", "handCount": 11, "team": 2 }
    ],
    "firstTurn": {
      "playerId": "uuid",
      "timeLimit": 30
    }
  }
}
```

#### `game:toss_result`
One event per toss round, in order, before the deal. The client ignores rounds with
`isTie: true` and animates the decisive `isTie: false` one, which carries `winnerPlayerId` /
`winnerSeatIndex` — that seat plays first.
```json
{
  "gameId": "game-uuid",
  "round": 1,
  "isTie": false,
  "winnerPlayerId": "uuid",
  "winnerSeatIndex": 2,
  "players": [
    { "playerId": "uuid", "seatIndex": 0, "card": { "id": "…", "suit": "HEARTS", "rank": "K", "isWild": false }, "rankValue": 13 }
  ]
}
```

**No Jokers in the toss, in either mode** (fixed 2026-08-30). The toss deck is built without
them, so `rank` is never `"JOKER"` here and `rankValue` runs 2…14 — Ace (14) is the highest
card a seat can toss, then King (13) down to 2. Classic's *play* deck still contains its four
jokers; this is the toss draw only. Equal top cards are a tie and the round is re-tossed.

#### `game:player_turn`
Signals whose turn it is.
```json
{
  "event": "game:player_turn",
  "data": {
    "gameId": "game-uuid",
    "playerId": "uuid",
    "username": "CoolPlayer",
    "turnNumber": 5,
    "timeLimit": 30,
    "canDrawDiscard": true
  }
}
```

#### `game:move_played`
Broadcast to all players after each valid move.
```json
{
  "event": "game:move_played",
  "data": {
    "gameId": "game-uuid",
    "playerId": "uuid",
    "moveType": "DRAW_STOCK",
    "result": {
      "stockPileCount": 85,
      "handCount": 12
    },
    "nextTurnPlayerId": "uuid2",
    "turnTimeLimit": 30
  }
}
```

For DISCARD moves, also includes:
```json
{
  "moveType": "DISCARD",
  "result": {
    "discardedCard": { "id": "card-7", "suit": "CLUBS", "rank": "KING" },
    "handCount": 11
  }
}
```

For MELD moves:
```json
{
  "moveType": "PLAY_MELD",
  "result": {
    "meld": {
      "id": "meld-new",
      "playerId": "uuid",
      "cards": [...],
      "isCanasta": false,
      "isNatural": false
    },
    "handCount": 8
  }
}
```

#### `game:state_update`
Full game state broadcast (sent after pot pickup, canasta completion, or reconnect).
```json
{
  "event": "game:state_update",
  "data": {
    "gameId": "game-uuid",
    "myHand": [...],
    "myMelds": [...],
    "allMelds": {
      "uuid": [...],
      "uuid2": [...]
    },
    "stockPileCount": 60,
    "discardTop": {...},
    "potPiles": [...],
    "scores": { "team1": 340, "team2": 120 },
    "currentTurn": { "playerId": "uuid", "timeRemaining": 22 }
  }
}
```

#### `game:move_invalid`
Sent only to the player who made the invalid move.
```json
{
  "event": "game:move_invalid",
  "data": {
    "gameId": "game-uuid",
    "reason": "INVALID_MELD",
    "message": "A set must have at least 3 cards of the same rank"
  }
}
```

#### `game:turn_timeout`
Player's turn timed out, auto-action taken.
```json
{
  "event": "game:turn_timeout",
  "data": {
    "gameId": "game-uuid",
    "playerId": "uuid",
    "autoAction": "DISCARD",
    "card": { "id": "card-1", "suit": "HEARTS", "rank": "2" }
  }
}
```

#### Turn timer fields (updated 2026-08-11)

Every full-state payload carries the turn clock. A turn — anyone's, present or auto-played —
always runs for the table's own configured length. There is no shortened window: an earlier
version of the server dropped to a flat 5 seconds once a player had one turn auto-played,
which both ignored the table's actual setting and made the on-screen countdown look like it
had "reset" to 5s instead of reflecting the room. Turns now time out on schedule and still
climb toward the 12-turn forfeit below — just at the table's own pace, same as anyone else's.

| Field | Meaning |
|-------|---------|
| `turnDuration` | Seconds the **current** turn actually lasts — always the room setting (default 30). Size the timer ring from this |
| `turnDurationBase` | The room's configured value — identical to `turnDuration` today; kept as a separate field for clients that want "the table's rule" by name |
| `turnFastAutoplay` | Always `false` today (kept for client compatibility; reserved in case a shortened window is reintroduced later) |
| `turnTimeRemaining` | Whole seconds left, measured against `turnDuration` |
| `turnStartedAt` / `turnEndsAt` | Epoch ms. `turnEndsAt = turnStartedAt + turnDuration × 1000` — drive the countdown from this to avoid drift |
| `dealingComplete` | `false` while cards are still being dealt at this table. Hold the timer UI until it is `true` — see below |

All fields come from one server-side definition, which is also the value the timeout cron
acts on.

#### Deal gate — the turn timer starts after dealing (added 2026-08-30)

The clock used to start the instant the server dealt, so the first player's countdown — and
their AFK strike with it — ran while every phone was still animating cards onto the table.
It now starts when the **deal finishes**, at match start and at every new round.

Sequence:

1. Server deals and sends `game:deal_start` (round 1) or `game:new_round` (later rounds).
   Both carry `dealingComplete: false`.
2. Each client animates the deal, then sends **`game:deal_complete`**.
3. Once every seat has reported in, the server starts the turn clock **from that moment** and
   broadcasts **`game:dealing_complete`** — a normal full-state payload, now with
   `dealingComplete: true` and a fresh `turnStartedAt` / `turnEndsAt`. Start the countdown here.

While `dealingComplete` is `false`:

- **No countdown.** `turnTimeRemaining` stays at the full `turnDuration` and `turnEndsAt`
  keeps sliding forward, so nothing ticks down however long the deal takes.
- **No AFK autoplay.** The timeout cron skips the table entirely; no `missedTurns` /
  `awayTurns` strike can be scored against a turn that has not started.
- **No moves.** Any `game:move:*` is rejected with `game:move_invalid` and
  `reason: "Please wait until all players are done dealing"` — including from the player
  whose turn it is. Show that text and keep the board locked.

**Backstop.** If a seat never sends `game:deal_complete` (a client that predates the event, a
player who never connects), the server opens the gate by itself 15 seconds after the deal and
broadcasts `game:dealing_complete` as normal. A missing ack costs that table an idle window;
it can never freeze a match.

#### AFK forfeit — 12 auto-played turns ends the MATCH

Each seat carries two counters in `players[]`: `missedTurns` and `awayTurns`. Both are
match-wide tallies, cleared **only** by a manual move (see `game:move:*`) — a bare
reconnect, or a new round starting, never resets either one. A player who disconnects,
reconnects, and goes AFK again resumes counting from where they left off instead of getting
a free reset. Thresholds are published as `awayAfterTurns` (6) and `forfeitAfterTurns` (12)
so the client never hardcodes them.

When `awayTurns` reaches **12**, the match ends on that same turn with a single `game:end`:

- `reason: "player_abandoned"` — the forfeiter's socket was gone
- `reason: "inactive_forfeit"` — still connected, but 12 turns were auto-played
- `reason: "both_players_away"` with `isDraw: true`, `winnerTeam: 0` — every opponent is
  also away, so the win isn't handed to whoever happened to cross 12 second

**`game:new_round` is never emitted for this case**, including when that 12th auto-turn also
exhausts the stock and would otherwise have ended the round: the forfeit is evaluated before
any round transition, so the round does not advance and no new hand is dealt. A client that
receives `game:end` should go straight to the final scoreboard.

A player who was disconnected at that moment receives the same terminal payload as
`game:end` with `reason: "already_ended"` on their next `game:join` / `game:reconnect`.

#### `game:player_disconnected`
A player disconnected mid-game.
```json
{
  "event": "game:player_disconnected",
  "data": {
    "gameId": "game-uuid",
    "playerId": "uuid",
    "username": "DisconnectedPlayer",
    "reconnectWindowSeconds": 60
  }
}
```

#### `game:player_reconnected`
Disconnected player came back.
```json
{
  "event": "game:player_reconnected",
  "data": {
    "gameId": "game-uuid",
    "playerId": "uuid",
    "username": "BackPlayer"
  }
}
```

#### `game:state_sync`
Full state sent only to reconnecting player.
```json
{
  "event": "game:state_sync",
  "data": {
    "gameId": "game-uuid",
    "myHand": [...],
    "myMelds": [...],
    "allMelds": {...},
    "stockPileCount": 55,
    "discardPile": [...],
    "potPiles": [...],
    "scores": {...},
    "currentTurn": {...},
    "turnNumber": 18,
    "players": [...]
  }
}
```

#### `game:end`
Game has ended.
```json
{
  "event": "game:end",
  "data": {
    "gameId": "game-uuid",
    "result": "WIN",
    "winnerTeam": 1,
    "winnerIds": ["uuid", "uuid2"],
    "finalScores": {
      "team1": 850,
      "team2": 320
    },
    "playerResults": [
      {
        "userId": "uuid",
        "username": "Me",
        "score": 425,
        "result": "WIN",
        "rewards": { "coins": 1000, "xpGained": 150, "newLevel": 13 }
      }
    ],
    "duration": 720
  }
}
```

#### `game:abandoned`
Game abandoned (player left, not disconnected).
```json
{
  "event": "game:abandoned",
  "data": {
    "gameId": "game-uuid",
    "reason": "PLAYER_LEFT",
    "leftPlayerId": "uuid",
    "refund": { "coins": 500 }
  }
}
```

---

## Debug / QA Events (TEMPORARY)

Test-build only. Exists so QA can reach the 75-rule scenario without first playing a full
round to 1000 points. Turn the whole section off on a server with `DEBUG_GAME_EVENTS=false`
(default: on). To be removed once the 75-rule is signed off.

### CLIENT → SERVER

#### `game:debug:force_round`
Re-deals the caller's live match as a later round with both teams parked on 1000 points,
which is the only state where the 75-rule applies. Caller must be a player in the game and
the match must still be `IN_PROGRESS`.

```json
{
  "gameId": "game-uuid"
}
```

`gameId` may also be sent as a bare string, and is optional — it falls back to the caller's
active game. Optional overrides:

| Field | Default | Purpose |
|-------|---------|---------|
| `round` | current + 1 (min 2) | Land on a specific round number |
| `teamScore` | `1000` | Cumulative score given to BOTH teams. Below 1000 the 75-rule stays OFF — use it to check the rule does **not** fire |

Does **not** score, settle, reward or end the match, and does not touch the AFK / forfeit
counters. Every other player at the table simply receives the normal `game:new_round`.

### SERVER → CLIENT

#### `game:debug:force_round_ack`
Sent to the caller only.
```json
{
  "event": "game:debug:force_round_ack",
  "data": {
    "gameId": "game-uuid",
    "round": 2,
    "matchScores": { "1": 1000, "2": 1000 },
    "seventyFiveRule": {
      "player-uuid": { "active": true, "requirement": 75, "satisfied": false }
    },
    "currentPlayerId": "player-uuid"
  }
}
```

#### `game:debug:error`
```json
{
  "event": "game:debug:error",
  "data": { "code": "FORCE_ROUND_FAILED", "message": "GAME_NOT_IN_PROGRESS" }
}
```
Codes: `DEBUG_DISABLED`, `INVALID_PAYLOAD`, `FORCE_ROUND_FAILED` (message is `NOT_IN_GAME`,
`GAME_NOT_IN_PROGRESS` or `Game not found`).

#### `game:new_round` (broadcast)
The standard round-transition payload, plus `"debugForced": true`. Clients that ignore the
extra field need no changes at all.

---

## Chat Events

**Namespace:** `/chat`

### CLIENT → SERVER

#### `chat:send`
Send a text message.
```json
{
  "conversationId": "conv-uuid",
  "content": "Good game!"
}
```

#### `chat:typing`
Signal typing indicator.
```json
{
  "conversationId": "conv-uuid",
  "isTyping": true
}
```

#### `chat:read`
Mark messages as read.
```json
{
  "conversationId": "conv-uuid"
}
```

---

### SERVER → CLIENT

#### `chat:message`
New message received.
```json
{
  "event": "chat:message",
  "data": {
    "messageId": "msg-uuid",
    "conversationId": "conv-uuid",
    "senderId": "uuid",
    "senderUsername": "BestFriend",
    "senderAvatarUrl": "...",
    "type": "TEXT",
    "content": "Good game!",
    "createdAt": "2024-01-01T12:00:00.000Z"
  }
}
```

#### `chat:voice_message`
New voice message received.
```json
{
  "event": "chat:voice_message",
  "data": {
    "messageId": "msg-uuid",
    "conversationId": "conv-uuid",
    "senderId": "uuid",
    "senderUsername": "BestFriend",
    "type": "VOICE",
    "voiceUrl": "https://cdn.buraco.game/voice/msg.mp3",
    "duration": 8,
    "createdAt": "2024-01-01T12:01:00.000Z"
  }
}
```

#### `chat:typing`
Typing indicator from another user.
```json
{
  "event": "chat:typing",
  "data": {
    "conversationId": "conv-uuid",
    "userId": "uuid",
    "username": "BestFriend",
    "isTyping": true
  }
}
```

#### `chat:read_receipt`
Messages marked as read by recipient.
```json
{
  "event": "chat:read_receipt",
  "data": {
    "conversationId": "conv-uuid",
    "readByUserId": "uuid",
    "readAt": "2024-01-01T12:02:00.000Z"
  }
}
```

---

## Notification Events

**Namespace:** `/` (default)

### SERVER → CLIENT

#### `notification:new`
Real-time notification delivery.
```json
{
  "event": "notification:new",
  "data": {
    "id": "notif-uuid",
    "type": "FRIEND_REQUEST",
    "title": "New Friend Request",
    "body": "CoolPlayer sent you a friend request",
    "data": { "requestId": "req-uuid" },
    "createdAt": "2024-01-01T10:00:00.000Z"
  }
}
```

#### `notification:unread_count`
Unread count update after new notification.
```json
{
  "event": "notification:unread_count",
  "data": { "count": 4 }
}
```

---

## Presence Events

**Namespace:** `/` (default)

### SERVER → CLIENT

#### `presence:online`
A friend came online.
```json
{
  "event": "presence:online",
  "data": {
    "userId": "uuid",
    "username": "BestFriend"
  }
}
```

#### `presence:offline`
A friend went offline.
```json
{
  "event": "presence:offline",
  "data": {
    "userId": "uuid",
    "username": "BestFriend",
    "lastSeen": "2024-01-01T12:00:00.000Z"
  }
}
```

---

## Error Handling

All WebSocket errors follow this format:
```json
{
  "event": "error",
  "data": {
    "code": "NOT_YOUR_TURN",
    "message": "It is not your turn to play",
    "originalEvent": "game:move:draw"
  }
}
```

### Common WebSocket Error Codes
| Code | Description |
|------|-------------|
| `AUTH_FAILED` | Token invalid on handshake |
| `TOKEN_EXPIRED` | Token expired, reconnect with new token |
| `ROOM_NOT_FOUND` | Room no longer exists |
| `GAME_NOT_FOUND` | Game session not found |
| `NOT_IN_GAME` | Not a participant in this game |
| `NOT_YOUR_TURN` | Move submitted out of turn |
| `INVALID_MOVE` | Move violates rules |
| `NOTHING_TO_CANCEL` | `game:move:cancel_melds` sent with no pending 75-rule melds to return |
| `GAME_ENDED` | Game already over |
| `RATE_LIMITED` | Too many events sent |

---

## Unity Integration Notes

### Connection Lifecycle
```
1. Unity calls POST /auth/login → receives accessToken
2. Unity connects WebSocket with token in handshake
3. On token expiry (900s), Unity calls POST /auth/refresh
4. Unity reconnects WebSocket with new token
5. If mid-game reconnect → send game:reconnect event with gameId
6. Server responds with game:state_sync
```

### Recommended Event Handling Pattern
```
- Subscribe to room:list_update when showing lobby
- Unsubscribe from room:list_update when entering game
- Subscribe to /game namespace when game starts
- All game moves sent via WebSocket (not REST)
- REST only for: profile, stats, shop, friends, history
```

### Turn Timer
- Server sends `game:player_turn` with `timeLimit` in seconds
- Client displays countdown
- Server is authoritative — server-side timer will auto-discard on expiry
- Client timer is cosmetic only
