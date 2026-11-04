/**
 * Startup checks for settings that must never be weak on a live server.
 *
 * The secrets below sign player and admin login tokens. Missing, short or left at the
 * .env.example placeholder, anyone could forge a token — including an admin one. In
 * production (NODE_ENV=production) the server refuses to start; elsewhere it only warns,
 * so local development keeps working.
 */
export const REQUIRED_SECRETS = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ADMIN_JWT_SECRET'] as const;
export const MIN_SECRET_LENGTH = 32;

export function secretProblems(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const values = new Map<string, string>();

  for (const name of REQUIRED_SECRETS) {
    const value = (env[name] ?? '').trim();
    if (!value) {
      problems.push(`${name} is not set`);
      continue;
    }
    if (/change-?me/i.test(value)) problems.push(`${name} is still the .env.example placeholder`);
    else if (value.length < MIN_SECRET_LENGTH) problems.push(`${name} is shorter than ${MIN_SECRET_LENGTH} characters`);
    values.set(name, value);
  }

  // Sharing one secret would let a refresh token pass as an access token, or a player
  // token as an admin one.
  const seen = new Map<string, string>();
  for (const [name, value] of values) {
    const other = seen.get(value);
    if (other) problems.push(`${name} must differ from ${other}`);
    else seen.set(value, name);
  }
  return problems;
}

/** Throws in production when a secret is unsafe; returns the problems otherwise. */
export function checkSecretsOrThrow(env: Record<string, string | undefined> = process.env): string[] {
  const problems = secretProblems(env);
  if (problems.length && env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to start: unsafe secrets in .env\n  - ' + problems.join('\n  - ') +
      '\nGenerate each with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"',
    );
  }
  return problems;
}
