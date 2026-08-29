import type { NextConfig } from 'next';

/*
 * Every directive below was chosen against what the built page actually loads,
 * measured on the deployed site rather than copied from a template:
 *   - 2 inline <script> blocks (Next's hydration payload)
 *   - 0 inline <style> blocks; one same-origin stylesheet
 *   - fonts self-hosted by next/font, so no external font origin
 *   - the only non-same-origin image is the local blob: object URL preview
 *   - every fetch goes to /api/*, so connect-src stays same-origin
 */
const csp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self'",
  // Belt to X-Frame-Options' braces. The page states a verdict about money, so
  // an attacker framing it under their own listing and overlaying it is the
  // realistic abuse here, more than script injection.
  "frame-ancestors 'none'",
  // COMPATIBILITY DEBT, deliberately taken and deliberately narrow: Next's App
  // Router ships its hydration payload in inline <script> tags, so without
  // 'unsafe-inline' the page does not boot. Removal path is a nonce issued in
  // middleware plus 'strict-dynamic', which costs the static prerender of `/`;
  // not worth it while there is no user-generated HTML anywhere on the page.
  // Nothing else is loosened, and adding a nonce later makes browsers ignore
  // this token automatically.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self'",
  // blob: is the photo preview, which is a local object URL and never leaves
  // the browser. data: is not needed today but is what an <img> falls back to
  // if one is ever inlined.
  "img-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self'",
  'upgrade-insecure-requests',
].join('; ');

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Not strict-origin-when-cross-origin: the referrer would tell every
          // site a user opens from the evidence list that they arrived from a
          // rental-scam checker. Outbound links already carry rel="noreferrer";
          // this covers everything else.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
