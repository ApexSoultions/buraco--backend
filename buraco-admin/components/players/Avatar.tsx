'use client';
import { useState } from 'react';

/**
 * Where the panel loads a player picture from. Built-in avatars ("/avatars/…" on the game
 * server) go through the panel's own address (see next.config.ts); uploaded pictures (https)
 * load directly.
 */
export function avatarSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/avatars/')) return url;
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/avatars/')) return u.pathname;
    return u.protocol === 'https:' || u.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** Round player picture; shows the name's first letters when there is none or it fails to load. */
export default function Avatar({ url, name, size = 48 }: { url: string | null | undefined; name: string; size?: number }) {
  const src = avatarSrc(url);
  const [failed, setFailed] = useState<string | null>(null);
  const show = src && failed !== src;
  return (
    <div className="rounded-full bg-slate-100 overflow-hidden shrink-0 flex items-center justify-center text-slate-500 font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.32 }}>
      {show
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={src} alt="" className="w-full h-full object-cover" onError={() => setFailed(src)} />
        : name.slice(0, 2).toUpperCase()}
    </div>
  );
}
