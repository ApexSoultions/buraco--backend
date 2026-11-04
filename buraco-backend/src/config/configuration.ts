export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  appUrl: process.env.APP_URL || 'http://localhost:3000',

  database: {
    url: process.env.DATABASE_URL,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  },

  apple: {
    clientId: process.env.APPLE_CLIENT_ID,
    teamId: process.env.APPLE_TEAM_ID,
    keyId: process.env.APPLE_KEY_ID,
    privateKey: process.env.APPLE_PRIVATE_KEY,
  },

  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    s3Bucket: process.env.AWS_S3_BUCKET,
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT ?? '587', 10) || 587,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || 'noreply@buraco.game',
  },

  admin: {
    jwtSecret: process.env.ADMIN_JWT_SECRET,
    jwtExpiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '8h',
  },

  throttle: {
    /** Window in seconds for every limit below. */
    ttl: parseInt(process.env.THROTTLE_TTL ?? '60', 10) || 60,
    /** Requests per window for a signed-in player (counted per player, not per IP). */
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10) || 100,
    /** Requests per window per IP for signed-out traffic (login, register, password reset). */
    anonLimit: parseInt(process.env.THROTTLE_ANON_LIMIT ?? '60', 10) || 60,
    // Socket chat has its own limit, THROTTLE_CHAT_PER_10S, read in AppGateway.
  },

  game: {
    disconnectTimeoutSeconds: parseInt(process.env.DISCONNECT_TIMEOUT_SECONDS ?? '60', 10) || 60,
    defaultTurnDuration: parseInt(process.env.DEFAULT_TURN_DURATION ?? '30', 10) || 30,
    newUserCoins: parseInt(process.env.NEW_USER_COINS ?? '1000', 10) || 1000,
    newUserDiamonds: parseInt(process.env.NEW_USER_DIAMONDS ?? '0', 10) || 0,
    newUserLives: parseInt(process.env.NEW_USER_LIVES ?? '5', 10) || 5,
    // Switch for the QA socket event `game:debug:force_round`, which jumps a live match to a
    // later round. OFF unless DEBUG_GAME_EVENTS=true: it used to default to on, which left it
    // usable by any player on the live server. Turn it on in a local or test .env only.
    debugEventsEnabled: (process.env.DEBUG_GAME_EVENTS ?? 'false').trim().toLowerCase() === 'true',
  },

  /** API docs page at `/`. On unless SWAGGER_ENABLED=false (turn it off for the public release). */
  swagger: {
    enabled: (process.env.SWAGGER_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
  },
});
