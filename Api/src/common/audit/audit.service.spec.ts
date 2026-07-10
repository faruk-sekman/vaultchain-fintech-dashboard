/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the tamper-evident audit trail. The pure hash primitives
 * (stableStringify, computeEntryHash) are the heart of the chain's tamper-evidence, so they get the
 * most attention: key-order independence, determinism, and that ANY payload or prev_hash change
 * moves the hash. `record` is tested with a mocked Prisma client (genesis seed + chain linkage), and
 * a minimal entry pins the optional-field defaulting (resourceId/context → null/undefined).
 */
import { AuditService, AUDIT_GENESIS_SEED, computeEntryHash, stableStringify } from './audit.service';

describe('stableStringify', () => {
  it('is independent of object key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('serializes nested objects, arrays, and null deterministically', () => {
    expect(stableStringify({ z: [3, { y: 1, x: 2 }], a: null })).toBe('{"a":null,"z":[3,{"x":2,"y":1}]}');
  });

  it('falls back to JSON for primitives', () => {
    expect(stableStringify('hi')).toBe('"hi"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(null)).toBe('null');
  });

  it('coerces an undefined value to the literal "null" (JSON.stringify(undefined) → "null" fallback)', () => {
    // JSON.stringify(undefined) returns undefined; the `?? 'null'` guard must produce a parseable token
    // so a payload field that is explicitly undefined never breaks the canonical string / hash.
    expect(stableStringify(undefined)).toBe('null');
    // And as a nested value: an undefined property still yields a stable, parseable canonical form.
    expect(stableStringify({ a: undefined as unknown, b: 1 })).toBe('{"a":null,"b":1}');
  });
});

describe('computeEntryHash', () => {
  const payload = { id: 'a', action: 'wallet.update_limits', outcome: 'SUCCESS' };

  it('produces a stable 64-char SHA-256 hex digest', () => {
    const hash = computeEntryHash('prev', payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeEntryHash('prev', payload)).toBe(hash); // deterministic
  });

  it('is key-order independent for the payload (canonical form)', () => {
    expect(computeEntryHash('prev', { a: 1, b: 2 })).toBe(computeEntryHash('prev', { b: 2, a: 1 }));
  });

  it('changes when the previous hash changes (chain linkage)', () => {
    expect(computeEntryHash('prev-1', payload)).not.toBe(computeEntryHash('prev-2', payload));
  });

  it('changes when any payload field is tampered with', () => {
    expect(computeEntryHash('prev', payload)).not.toBe(computeEntryHash('prev', { ...payload, outcome: 'DENIED' }));
  });
});

describe('AuditService.record', () => {
  const entry = {
    actorUserId: 'user-1',
    action: 'wallet.update_limits',
    resourceType: 'wallet',
    resourceId: 'wallet-1',
    outcome: 'SUCCESS' as const,
    context: { dailyLimitMinor: 100_000 },
  };

  /** A transaction client exposing the three calls `append` makes. */
  const makeTx = (lastRows: Array<{ entry_hash: string }> = []) => ({
    $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: jest.fn().mockResolvedValue(lastRows),
    auditLog: { create: jest.fn().mockResolvedValue(undefined) },
  });

  it('appends within the caller transaction when one is provided (atomic, no own tx)', async () => {
    const tx = makeTx();
    const prisma = { $transaction: jest.fn() };
    const service = new AuditService(prisma as never);

    await service.record(entry, tx as never);

    expect(tx.auditLog.create).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('opens its own transaction for a standalone record', async () => {
    const tx = makeTx();
    const prisma = { $transaction: jest.fn((cb: (c: unknown) => unknown) => cb(tx)) };
    const service = new AuditService(prisma as never);

    await service.record(entry);

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalled();
  });

  it('seeds prev_hash from the genesis constant when the chain is empty', async () => {
    const tx = makeTx([]); // no prior rows
    const service = new AuditService({ $transaction: jest.fn() } as never);

    await service.record(entry, tx as never);

    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ prevHash: AUDIT_GENESIS_SEED }) }),
    );
  });

  it('links prev_hash to the last row and serializes appends under an advisory lock', async () => {
    const tx = makeTx([{ entry_hash: 'deadbeef'.repeat(8) }]);
    const service = new AuditService({ $transaction: jest.fn() } as never);

    await service.record(entry, tx as never);

    // The chain links to the prior row's hash...
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ prevHash: 'deadbeef'.repeat(8) }) }),
    );
    // ...and appends are serialized by the Postgres advisory lock.
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'));
  });

  it('defaults the optional fields when a minimal entry omits resourceId / context / ipHash / correlationId', async () => {
    const tx = makeTx([]);
    const service = new AuditService({ $transaction: jest.fn() } as never);

    // A DENIED-style standalone row carries no resource id, no context, no ip/correlation — the service
    // must default these (`?? null` / `?? undefined`) rather than persist `undefined`, so the chain hash
    // is computed over a fully-resolved canonical payload.
    await service.record({
      actorUserId: 'user-2',
      action: 'access.denied',
      resourceType: 'customer',
      outcome: 'DENIED',
    }, tx as never);

    const data = tx.auditLog.create.mock.calls[0][0].data;
    expect(data.resourceId).toBeNull(); // `entry.resourceId ?? null`
    expect(data.maskedContextJson).toBeUndefined(); // `(entry.context ?? undefined)`
    expect(data.ipHash).toBeNull(); // `entry.ipHash ?? null`
    expect(data.correlationId).toBeNull(); // `entry.correlationId ?? null`
    // The hash still computes (genesis-seeded) and is a valid digest over the resolved payload.
    expect(data.prevHash).toBe(AUDIT_GENESIS_SEED);
    expect(data.entryHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
