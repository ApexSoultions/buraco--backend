import configuration from './configuration';
import { checkSecretsOrThrow, secretProblems } from './env-check';

// The live server must not run with forgeable login tokens or the QA cheat switched on.
const strong = (c: string) => c.repeat(40);
const good = { JWT_SECRET: strong('a'), JWT_REFRESH_SECRET: strong('b'), ADMIN_JWT_SECRET: strong('c') };

describe('secretProblems', () => {
  it('accepts three different long secrets', () => {
    expect(secretProblems(good)).toEqual([]);
  });

  it('reports missing, placeholder, short and shared secrets', () => {
    expect(secretProblems({})).toEqual([
      'JWT_SECRET is not set', 'JWT_REFRESH_SECRET is not set', 'ADMIN_JWT_SECRET is not set',
    ]);
    expect(secretProblems({ ...good, ADMIN_JWT_SECRET: 'change-me-admin-secret' }))
      .toEqual(['ADMIN_JWT_SECRET is still the .env.example placeholder']);
    expect(secretProblems({ ...good, JWT_SECRET: 'short' })).toEqual(['JWT_SECRET is shorter than 32 characters']);
    expect(secretProblems({ ...good, JWT_REFRESH_SECRET: good.JWT_SECRET }))
      .toEqual(['JWT_REFRESH_SECRET must differ from JWT_SECRET']);
  });
});

describe('checkSecretsOrThrow', () => {
  it('refuses to start in production with an unsafe secret', () => {
    expect(() => checkSecretsOrThrow({ ...good, JWT_SECRET: 'change-me', NODE_ENV: 'production' }))
      .toThrow(/Refusing to start[\s\S]*JWT_SECRET/);
  });

  it('only warns outside production, so local development keeps working', () => {
    expect(checkSecretsOrThrow({ NODE_ENV: 'development' })).toHaveLength(3);
  });

  it('starts in production with good secrets', () => {
    expect(checkSecretsOrThrow({ ...good, NODE_ENV: 'production' })).toEqual([]);
  });
});

describe('configuration switches', () => {
  const withEnv = (env: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    try { return configuration(); } finally { process.env = saved; }
  };

  it('the QA force-round event is off unless DEBUG_GAME_EVENTS=true', () => {
    expect(withEnv({ DEBUG_GAME_EVENTS: undefined }).game.debugEventsEnabled).toBe(false);
    expect(withEnv({ DEBUG_GAME_EVENTS: 'false' }).game.debugEventsEnabled).toBe(false);
    expect(withEnv({ DEBUG_GAME_EVENTS: 'yes' }).game.debugEventsEnabled).toBe(false);
    expect(withEnv({ DEBUG_GAME_EVENTS: 'TRUE' }).game.debugEventsEnabled).toBe(true);
  });

  it('the API docs page is on unless SWAGGER_ENABLED=false', () => {
    expect(withEnv({ SWAGGER_ENABLED: undefined }).swagger.enabled).toBe(true);
    expect(withEnv({ SWAGGER_ENABLED: 'false' }).swagger.enabled).toBe(false);
  });
});
