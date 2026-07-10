/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the coarse User-Agent summary (A15). Real-world UA strings per browser × OS family,
 * the precedence rules (Edge before Chrome, Chrome before Safari, Android before Linux, iOS device
 * tokens), the partial-match degradations, and the "Unknown device" fallback.
 */
import { summarizeUserAgent } from './user-agent';

const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const EDGE_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const FIREFOX_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15';

describe('summarizeUserAgent', () => {
  it('maps the common desktop families to "<Browser> on <OS>"', () => {
    expect(summarizeUserAgent(CHROME_WIN)).toBe('Chrome on Windows');
    expect(summarizeUserAgent(CHROME_MAC)).toBe('Chrome on macOS');
    expect(summarizeUserAgent(FIREFOX_LINUX)).toBe('Firefox on Linux');
    expect(summarizeUserAgent(SAFARI_MAC)).toBe('Safari on macOS');
  });

  it('Edge wins over the embedded Chrome/Safari tokens (most-specific first)', () => {
    expect(summarizeUserAgent(EDGE_WIN)).toBe('Edge on Windows');
  });

  it('mobile: Android wins over the embedded Linux token; iOS is detected from the device token', () => {
    expect(summarizeUserAgent(CHROME_ANDROID)).toBe('Chrome on Android');
    expect(summarizeUserAgent(SAFARI_IOS)).toBe('Safari on iOS');
    expect(summarizeUserAgent(FIREFOX_IOS)).toBe('Firefox on iOS');
  });

  it('degrades gracefully on a partial match (browser-only / OS-only)', () => {
    expect(summarizeUserAgent('weird-agent Chrome/1.0')).toBe('Chrome');
    expect(summarizeUserAgent('something (Windows NT 10.0) custom')).toBe('Windows');
  });

  it('falls back to "Unknown device" for absent, blank, or unrecognized input', () => {
    expect(summarizeUserAgent(undefined)).toBe('Unknown device');
    expect(summarizeUserAgent(null)).toBe('Unknown device');
    expect(summarizeUserAgent('')).toBe('Unknown device');
    expect(summarizeUserAgent('   ')).toBe('Unknown device');
    expect(summarizeUserAgent('curl/8.4.0')).toBe('Unknown device');
  });
});
