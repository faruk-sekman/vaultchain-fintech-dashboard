# Concurrent failed logins lose account-lockout increments

## Executive Summary

At revision `14fd9f26e600861275e6cccf3c72a0d551ef32c6`, the public login
endpoint can process overlapping wrong-password requests for the same account
without serialising the account's failure counter. Each request reads
`failedLoginCount`, calculates `currentCount + 1` in application memory, and
then writes that absolute value back. When several requests read the same
value, the last writer wins and the database records one failure instead of
the number of guesses that were processed. The documented five-failure,
15-minute lockout can therefore be delayed by concurrent bursts.

This is an authentication-attempt restriction race (CWE-362 and CWE-307).
Impact is medium (more online password guesses; the race does not reveal the
password), and likelihood is medium on a reachable developer/local-network
listener. The final policy severity is low, P3. Argon2id verification, the
10/minute/IP route throttle, the 100/minute/IP global throttle, and the
committed `lockedUntil` check reduce throughput but do not make the update
atomic or account-scoped.

I reviewed the vulnerable revision and the existing sequential unit tests
directly; I did not run a PostgreSQL concurrency reproduction because that
would mutate a database and was outside the authorised read-only validation
boundary. No fixed revision was present in the repository history.

## Background

The login route is deliberately public. `AuthController.login` accepts an
email and password, applies Nest's per-IP throttle, and forwards the values to
`AuthService.login`:

```ts
// Api/src/modules/auth/auth.controller.ts:38-52
@Post('login')
@Public()
@Throttle({ default: { limit: 10, ttl: 60_000 } })
async login(@Body() dto: LoginDto, @Req() req: FastifyRequest, ... ) {
  const outcome = await this.auth.login(dto.email, dto.password, {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    rememberDeviceToken: req.cookies[REMEMBER_COOKIE_NAME],
  });
  // ...set the session or MFA challenge cookie...
}
```

The service first normalises the email and fetches the user row. A committed
lock is checked before password work; a currently locked account receives a
423 response. Otherwise Argon2id verifies the supplied password. A wrong
password for a known user calls `registerFailure` with the `failedLoginCount`
from that `findUnique` result:

```ts
// Api/src/modules/auth/auth.service.ts:107-124
const user = await this.prisma.user.findUnique({ where: { email } });
if (user?.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
  await this.recordAttempt(user.id, email, false, 'locked', ctx?.ip);
  throw new HttpException({ code: 'Auth.AccountLocked', ... }, 423);
}

const verified = !!user && user.status === 'ACTIVE'
  && (await verify(user.passwordHash, password).catch(() => false));
if (!user || !verified) {
  if (user) await this.registerFailure(user.id, user.failedLoginCount, email, ctx?.ip);
  // ...generic InvalidCredentials response...
}
```

The intended contract is also stated in `SECURITY.md`: five failed logins
lock the account for 15 minutes, and a successful login resets the counter.
The API binds to `0.0.0.0` in `Api/src/main.ts:98-100`, so a developer-run
instance is reachable from its local network unless the surrounding network
configuration narrows that exposure.

## Vulnerability Details

### The read-to-write gap

`registerFailure` derives both the next count and the lock transition from a
request-local integer, then performs an unconditional update by user id:

```ts
// Api/src/modules/auth/auth.service.ts:296-303
private async registerFailure(userId: string, currentCount: number, email: string, ip?: string) {
  const failed = currentCount + 1;
  const locked = failed >= MAX_FAILED_LOGINS;
  await this.prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: failed,
      lockedUntil: locked ? new Date(Date.now() + LOCK_MS) : null,
    },
  });
  await this.recordAttempt(userId, email, false, 'bad_password', ip);
  if (locked) await this.notifyAccountLockout(userId);
}
```

There is no row lock, `UPDATE ... failedLoginCount = failedLoginCount + 1`,
compare-and-swap predicate, or transaction that carries the original read
through the write. `where: { id: userId }` only identifies the row; it does not
assert that the count is still the value the request observed.

We can model the bad state with two requests, A and B, starting from a row with
`failedLoginCount = 2`:

| Step | Request A | Request B | Stored row |
| --- | --- | --- | --- |
| 1 | `findUnique` reads `2` | `findUnique` reads `2` | `2` |
| 2 | computes `failed = 3` | computes `failed = 3` | `2` |
| 3 | writes absolute `3` | writes absolute `3` | `3` |

Both bad-password attempts have been verified and audited, but the row has
advanced by one. With six requests released against a row at zero, the same
interleaving can leave the row at one. A burst begun at four can let several
requests pass password verification before any of their writes makes
`lockedUntil` visible; those requests all compute five and race to write the
lock. The lock check at lines 111-118 protects later requests that observe a
committed lock, not requests already past the read.

The existing tests pin sequential behaviour (including counts one, four and
five) but do not overlap `login` calls or use a database. They therefore show
that the intended state machine works without contention, not that the
read-modify-write is safe under contention.

### Why the route throttle is not the missing invariant

The `10/minute/IP` decorator limits one source IP's request rate. It does not
serialise requests by account, and it cannot prevent a short in-window burst
or callers arriving through different source IPs. The global 100/minute/IP
limit has the same shape. Argon2id makes each password guess expensive, which
reduces the useful burst size, but the update remains a lost-update pattern.

## Exploitability Analysis

We first need a known (or guessed) email; no authentication is required to
reach `POST /api/v1/auth/login`. We then submit wrong passwords concurrently
so that their `findUnique` calls complete before the first failure update
commits. The attacker controls the email, guess values, concurrency and
timing. A simple burst can turn five intended failures into many password
verifications while the row advances only once per shared snapshot.

The strongest practical route is repeated bounded bursts. For a row at count
zero, a group of N overlapping guesses usually records one failure. Releasing
another group after the first update observes count one and repeats the effect.
At the final pre-lock count, requests that already passed the lock check can
all finish their Argon2 work before the first `lockedUntil` update is visible,
so the fifth-failure boundary is not a hard gate on the in-flight batch. A
correct password is still required for account takeover; this finding is a
control bypass that increases the online guessing budget, not a credential
disclosure or direct authorisation bypass.

Several constraints make stronger exploitation less reliable:

* Argon2id verification consumes CPU and creates a natural scheduling window,
  but also limits the number of useful guesses an attacker can sustain.
* The route and global throttles constrain a single source IP. Multiple source
  addresses or a proxy fleet would make the per-IP limit less relevant, while
  the account counter is still shared.
* Once any request observes a committed `lockedUntil`, the service returns
  423 before password verification. The race therefore delays the lock; it
  does not permanently remove it.
* A successful login resets `failedLoginCount` and `lockedUntil` in another
  unconditional update. Mixing a successful credential with failure bursts
  can produce additional last-writer-wins outcomes, but that is not needed to
  demonstrate this finding and would require knowing the password.

The repository describes a local portfolio/demo deployment with fictional
data and an intentionally public demo credential. That context limits
real-world harm and is why the matrix does not assign a higher severity. It
does not repair the shipped lockout invariant, and `0.0.0.0` binding leaves a
developer-run service reachable on its local network.

## Proof of Concept

The accompanying [`poc/README.md`](poc/README.md) is a safe, read-only
reproduction guide. It uses source inspection and a disposable in-memory
interleaving model; it does not connect to PostgreSQL, send requests to a
running service, use credentials, or mutate application data. The guide also
shows the exact static source commands and the expected stale-counter trace.

I did not claim a live result: no PostgreSQL timing or HTTP burst was run. A
proper disposable integration test should create a temporary database, seed a
user with a known test hash, release at least six wrong-password requests from
a barrier, and assert that an atomic implementation reaches the threshold.
That test is intentionally left as a follow-up because database mutation was
not authorised for this review.

## Remediation

The invariant to restore is: every failed-password attempt must consume one
account-scoped counter slot, and the lock transition must be decided from the
same serialised state. The minimal robust fix is to perform an atomic,
conditional SQL update (or an equivalent row-locked transaction) rather than
assigning a request-local absolute value. For example, the update can clamp
the count and set `lockedUntil` in one statement:

```ts
// Illustrative Prisma raw SQL; adapt the timestamp/enum details to the schema.
await prisma.$executeRaw`
  UPDATE "User"
  SET "failedLoginCount" = LEAST("failedLoginCount" + 1, ${MAX_FAILED_LOGINS}),
      "lockedUntil" = CASE
        WHEN "failedLoginCount" + 1 >= ${MAX_FAILED_LOGINS}
          THEN COALESCE("lockedUntil", ${new Date(Date.now() + LOCK_MS)})
        ELSE NULL
      END
  WHERE "id" = ${userId}
`;
```

An alternative is a short transaction that selects the user row `FOR UPDATE`,
computes the next value, updates it, and commits before returning the failure.
If the project stays with Prisma's typed update API, a compare-and-swap loop
can update `where: { id: userId, failedLoginCount: currentCount }`, retrying
when the predicate matches no row. Whichever form is chosen, the notification
should be emitted only when the transaction observes the transition to the
locked state, and audit records should remain one per processed attempt.

Regression coverage should include:

1. A disposable PostgreSQL integration test that releases six wrong-password
   calls concurrently and verifies a threshold lock, not a single increment.
2. A race at count four that proves all later requests are rejected after the
   first committed lock and that no request can clear `lockedUntil`.
3. A retry/compare-and-swap path that exercises a failed predicate and confirms
   no increments are lost.
4. Sequential tests for counts zero, four and five, plus a successful-login
   reset, to preserve the existing behaviour.
5. A throttler test showing that per-IP limits are defence in depth rather
   than the correctness mechanism for account lockout.

## Summary

The public login path reads a user's failed-login count and later writes
`currentCount + 1` as an unconditional absolute value. Concurrent requests
can therefore collapse many bad-password attempts into one stored increment,
delaying the declared five-failure lockout. Existing Argon2id verification,
throttling and committed-lock checks reduce throughput and bound the effect,
but none supplies account-scoped atomicity. I established the path with a
static review at revision `14fd9f26e600861275e6cccf3c72a0d551ef32c6` and did
not execute a database-mutating reproduction. Future variant analysis should
look for the same read-modify-write pattern in password-reset, MFA and other
attempt-budget controls, and the fix should make the serialisation invariant
explicit in both the database operation and its concurrency tests.
