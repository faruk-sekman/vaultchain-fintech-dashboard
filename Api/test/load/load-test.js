/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * k6 load test for the money-critical posting path (POST /api/v1/transactions). Logs in once in
 * setup(), then hammers the transactions endpoint under load with a fresh Idempotency-Key per
 * iteration. Thresholds enforce the SLO: P95 < 500ms and a server-error rate < 0.1%.
 *
 * Requires a running API (and seeded wallets) — it does NOT stub anything. Run:
 *   # quick smoke (default): 5 VUs, 30s
 *   k6 run Api/test/load/load-test.js
 *   # the brief's soak: 100 VUs for 1 hour, against seeded source/target wallets
 *   k6 run -e VUS=100 -e DURATION=1h -e SRC_WALLET=<uuid> -e DST_WALLET=<uuid> Api/load-test.js
 *
 * Env: BASE_URL, LOGIN_EMAIL, LOGIN_PASSWORD, VUS, DURATION, SRC_WALLET, DST_WALLET, CURRENCY.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const serverErrors = new Rate('server_errors');

const BASE = __ENV.BASE_URL || 'http://localhost:3000/api/v1';
const EMAIL = __ENV.LOGIN_EMAIL || 'admin@ftd.io';
const PASSWORD = __ENV.LOGIN_PASSWORD || 'Passw0rd!';
const CURRENCY = __ENV.CURRENCY || 'TRY';

export const options = {
  scenarios: {
    load: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 5),
      duration: __ENV.DURATION || '30s',
    },
  },
  thresholds: {
    // SLO: 95th-percentile latency under 500ms and a server-error rate under 0.1%.
    http_req_duration: ['p(95)<500'],
    server_errors: ['rate<0.001'],
    http_req_failed: ['rate<0.01'],
  },
};

function login() {
  const res = http.post(`${BASE}/auth/login`, JSON.stringify({ email: EMAIL, password: PASSWORD }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'login' },
  });
  check(res, { 'login returns a session': (r) => r.status === 200 });
  try {
    return res.json('data.accessToken');
  } catch (_e) {
    return null;
  }
}

// Authenticate once and share the token with every VU.
export function setup() {
  return { token: login() };
}

export default function (data) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.token}`,
    // A unique key per iteration so the idempotency guard treats each as a new post.
    'Idempotency-Key': `k6-${__VU}-${__ITER}-${Date.now()}`,
  };
  const payload = JSON.stringify({
    kind: 'TRANSFER',
    sourceWalletId: __ENV.SRC_WALLET || '00000000-0000-0000-0000-000000000000',
    targetWalletId: __ENV.DST_WALLET || '00000000-0000-0000-0000-000000000001',
    amountMinor: 100,
    currency: CURRENCY,
  });

  const res = http.post(`${BASE}/transactions`, payload, { headers, tags: { name: 'post-transaction' } });

  // A posted (201) or a deterministic business rejection (4xx) is a healthy response under load;
  // only 5xx counts against the error budget.
  check(res, { 'no server error': (r) => r.status < 500 });
  serverErrors.add(res.status >= 500);

  sleep(1);
}
