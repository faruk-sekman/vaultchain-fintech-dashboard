# Safe reproduction: lost login-lockout increments

This proof is intentionally read-only. It does **not** start the API, connect
to PostgreSQL, send login requests, use a credential, or modify application
data. It combines an exact source check with a small in-memory model of the
read/compute/write interleaving.

## Requirements

* A checkout of the repository at revision
  `14fd9f26e600861275e6cccf3c72a0d551ef32c6`.
* Git and Node.js (the model uses only the Node standard runtime).

## 1. Confirm the vulnerable source shape

From the repository root, verify the revision and inspect the login read and
failure write:

```sh
git show --no-patch --format='%H' 14fd9f26e600861275e6cccf3c72a0d551ef32c6
git show 14fd9f26e600861275e6cccf3c72a0d551ef32c6:Api/src/modules/auth/auth.service.ts \
  | sed -n '107,124p;296,303p'
```

The output should show `login` passing `user.failedLoginCount` to
`registerFailure`, followed by `failedLoginCount: failed` in an unconditional
`user.update`. The `where` clause contains only the user id; it does not
compare the count it read.

## 2. Model the lost update without a database

Run this disposable model directly; it creates no files and makes no network
calls:

```sh
node <<'NODE'
const startingCount = 2;
const parallelGuesses = 6;

// Every request performs findUnique before any update commits.
const snapshots = Array.from({ length: parallelGuesses }, () => startingCount);
const absoluteWrites = snapshots.map((count) => count + 1);

console.log(`snapshots: ${snapshots.join(', ')}`);
console.log(`writes:    ${absoluteWrites.join(', ')}`);
console.log(`stored count after last-writer-wins: ${absoluteWrites.at(-1)}`);
console.log(`attempts processed: ${parallelGuesses}`);
console.log(`increments retained: ${absoluteWrites.at(-1) - startingCount}`);
NODE
```

Representative output:

```text
snapshots: 2, 2, 2, 2, 2, 2
writes:    3, 3, 3, 3, 3, 3
stored count after last-writer-wins: 3
attempts processed: 6
increments retained: 1
```

The model is the same state transition as the source: six requests observe
`2`, all compute `3`, and an unconditional absolute update leaves the row at
`3`. A real database can schedule the reads and writes differently, but no
serialisation or compare-and-swap invariant exists in the checked-out code to
prevent this lost update.

## 3. What was deliberately not run

No HTTP burst or PostgreSQL test was run. Such a test would need a disposable
database and a seeded test account, would mutate the database, and was outside
the authorised read-only validation boundary for this report. To validate a
future fix, add a temporary integration test that releases at least six wrong
password calls at a barrier and asserts an atomic threshold lock; do not run it
against a shared, staging, or production database.

