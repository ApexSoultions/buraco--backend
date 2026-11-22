import Cookies from 'js-cookie';

const KEY     = 'admin_token';
const EXPIRES = 1 / 3; // 8 hours

export const getToken         = (): string | null => Cookies.get(KEY) ?? null;
export const isAuthenticated  = (): boolean       => !!getToken();

export function setToken(token: string) {
  // Strict: never sent when another site links here. Secure on HTTPS (Live), so the admin
  // token never travels unencrypted; plain http is only for running it locally.
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  Cookies.set(KEY, token, { expires: EXPIRES, path: '/', sameSite: 'strict', secure });
}

export function clearToken() {
  Cookies.remove(KEY, { path: '/' });
}
