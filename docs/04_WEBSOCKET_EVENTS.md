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

#### `game:reconnect`
Sent on reconnect to request full state sync.
```json
{
  "gameId": "game-uuid"
}
```

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
