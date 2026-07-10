/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Coarse User-Agent summary for admin read surfaces (A15 — the reset-request detail panel). PURE
 * function, no I/O, NO new dependency: a handful of regex families is deliberately all we do — this is
 * a human-readable hint ("Chrome on macOS"), not device fingerprinting. Computed at READ time from the
 * stored raw UA (never persisted itself), so improving the parser retroactively improves old rows.
 * Anything unrecognized collapses to the honest fallback "Unknown device".
 */

/** Browser families, ordered MOST-specific first (Edge ships "Chrome/…", Chrome ships "Safari/…"). */
const BROWSERS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'Edge', re: /\bEdge?\b|\bEdg(?:e|A|iOS)?\// },
  { name: 'Firefox', re: /\bFirefox\/|\bFxiOS\// },
  { name: 'Chrome', re: /\bChrome\/|\bCriOS\// },
  { name: 'Safari', re: /\bSafari\// },
];

/** OS families, ordered MOST-specific first (Android UAs contain "Linux"; iOS is device-token based). */
const SYSTEMS: ReadonlyArray<{ readonly name: string; readonly re: RegExp }> = [
  { name: 'Android', re: /\bAndroid\b/ },
  { name: 'iOS', re: /\b(?:iPhone|iPad|iPod)\b/ },
  { name: 'Windows', re: /\bWindows\b/ },
  { name: 'macOS', re: /\bMac OS X\b|\bMacintosh\b/ },
  { name: 'Linux', re: /\bLinux\b|\bX11\b/ },
];

/**
 * Summarize a raw User-Agent to a coarse "<Browser> on <OS>" label (e.g. "Chrome on Windows").
 * Partial matches degrade gracefully — browser-only ("Firefox") or OS-only ("Android") — and an
 * absent/blank/unrecognized UA is "Unknown device" (never null: the admin panel always shows a label).
 */
export function summarizeUserAgent(userAgent: string | null | undefined): string {
  const ua = userAgent?.trim();
  if (!ua) return 'Unknown device';
  const browser = BROWSERS.find(({ re }) => re.test(ua))?.name;
  const os = SYSTEMS.find(({ re }) => re.test(ua))?.name;
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return os;
  return 'Unknown device';
}
