/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Tamper-evident audit trail. Every governance/critical action appends a
 * row whose `entry_hash = SHA-256(prev_hash | canonical(payload))`, where `prev_hash` is the prior
 * row's `entry_hash` (a fixed genesis seed for row 0). Appends serialize on a Postgres advisory
 * lock so the chain stays linear under concurrency. Canonical serialization (sorted keys, ISO
 * timestamps) makes the hash reproducible for verification.
 *
 * Pass the caller's transaction so the audit is atomic with the business write (fail-closed: if the
 * audit can't be written, the whole change rolls back). Omit it for standalone (e.g. DENIED) rows.
 *
 * The external WORM anchor + concrete cloud KMS are deploy-time and tracked separately (SEC-003).
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { uuidv7 } from '../util/uuid';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** Fixed, documented, non-secret genesis seed (chain row 0's prev_hash). */
export const AUDIT_GENESIS_SEED = 'ftd-audit-genesis-v1';
/** Advisory-lock key that serializes chain appends. */
const AUDIT_LOCK_KEY = 424242;

export interface AuditEntry {
  /** The acting principal's user id, or `null` for a system-originated event with no known subject. */
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: 'SUCCESS' | 'DENIED' | 'FAIL';
  context?: Record<string, unknown> | null;
  ipHash?: string | null;
  correlationId?: string | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Append one audit row to the chain. Uses `tx` if given (atomic with the caller), else its own. */
  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    if (tx) {
      await this.append(tx, entry);
      return;
    }
    await this.prisma.$transaction((client) => this.append(client, entry));
  }

  private async append(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    // Serialize appends so two concurrent writers can't read the same "last" row.
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);
    const last = await tx.$queryRawUnsafe<Array<{ entry_hash: string }>>(
      'SELECT entry_hash FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT 1',
    );
    const prevHash = last[0]?.entry_hash ?? AUDIT_GENESIS_SEED;

    const id = uuidv7();
    const createdAt = new Date();
    const entryHash = computeEntryHash(prevHash, {
      id,
      actorUserId: entry.actorUserId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      outcome: entry.outcome,
      context: entry.context ?? null,
      // ip_hash + correlation_id are persisted security-forensic columns, so they must be covered by
      // the tamper-evident hash too — otherwise they are silently mutable (re-audit DATA-003).
      ipHash: entry.ipHash ?? null,
      correlationId: entry.correlationId ?? null,
      createdAt: createdAt.toISOString(),
    });

    await tx.auditLog.create({
      data: {
        id,
        actorUserId: entry.actorUserId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        outcome: entry.outcome,
        maskedContextJson: (entry.context ?? undefined) as Prisma.InputJsonValue | undefined,
        ipHash: entry.ipHash ?? null,
        correlationId: entry.correlationId ?? null,
        prevHash,
        entryHash,
        createdAt,
      },
    });
  }
}

/** `entry_hash = SHA-256(prev_hash | canonical(payload))` — exported for chain verification. */
export function computeEntryHash(prevHash: string, payload: Record<string, unknown>): string {
  return createHash('sha256').update(`${prevHash}|${stableStringify(payload)}`).digest('hex');
}

/** Deterministic JSON: object keys sorted recursively (reproducible across runtimes). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}
