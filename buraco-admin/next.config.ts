import type { NextConfig } from "next";

const apiUrl = (
  process.env.API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  'http://localhost:3000'
).replace(/\/+$/, '');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The panel may not be shown inside other sites (click-jacking), and browsers must not
  // guess file types or send the panel's address to other sites.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      {
        source: '/api/v1/:path*',
        destination: `${apiUrl}/v1/:path*`,
      },
      // The game's built-in avatars, through the panel's own address: the game server only
      // lets its own site show its files (Cross-Origin-Resource-Policy: same-origin).
      {
        source: '/avatars/:path*',
        destination: `${apiUrl}/avatars/:path*`,
      },
    ];
  },
};

export default nextConfig;
