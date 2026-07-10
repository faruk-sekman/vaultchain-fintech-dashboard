/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Parses + validates the customer-list query (api-endpoint-specifications §GET /customers).
 * Bracketed params (`page[number]`, `filter[q]`, `sort`) arrive as FLAT keys under Fastify's
 * default query parser, so we read them directly here — no `qs` dependency. Invalid input
 * throws a `400` in the standard error-envelope shape (`{ code, message }`).
 */
import { BadRequestException } from '@nestjs/common';
import { CustomerStatus, KycStatus, Prisma } from '@prisma/client';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const MAX_Q_LENGTH = 120;

/** sort field (FE/contract name) → Prisma Customer column. The whitelist also rejects anything else. */
const SORTABLE: Record<string, keyof Prisma.CustomerOrderByWithRelationInput> = {
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  fullName: 'fullName',
};

export interface ParsedCustomerListQuery {
  page: number;
  size: number;
  q?: string;
  kycStatus?: KycStatus;
  status?: CustomerStatus;
  /**
   * `filter[active]` — the unified active/passive taxonomy (TASK-FE-INT-013): `true` → ACTIVE,
   * `false` → not-ACTIVE (INACTIVE+CLOSED, matching the dashboard summary's `status <> 'ACTIVE'`).
   * Only applied by the service when an exact `status` is not supplied (exact `filter[status]` wins).
   */
  active?: boolean;
  /**
   * `?reveal=true` — request UNMASKED PII. Strict bi-state (default `false`): only the
   * literal `'true'` enables it. This is the REQUESTED intent only; the service grants it solely when
   * the principal also holds `customers.pii.reveal` (EFFECTIVE reveal), else it is silently masked.
   */
  reveal: boolean;
  orderBy: Prisma.CustomerOrderByWithRelationInput[];
}

function bad(code: string, message: string): never {
  throw new BadRequestException({ code, message });
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : String(v);
}

function parsePositiveInt(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) bad('Validation.Failed', `${field} must be a positive integer.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) bad('Validation.Failed', `${field} must be a positive integer.`);
  return n;
}

function parseSort(value: string | undefined): Prisma.CustomerOrderByWithRelationInput[] {
  if (!value || value.trim() === '') return [{ updatedAt: 'desc' }];
  const orderBy: Prisma.CustomerOrderByWithRelationInput[] = [];
  for (const tokenRaw of value.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const desc = token.startsWith('-');
    const field = desc ? token.slice(1) : token;
    const column = SORTABLE[field];
    if (!column) bad('Validation.Failed', `sort field "${field}" is not sortable.`);
    orderBy.push({ [column]: desc ? 'desc' : 'asc' });
  }
  return orderBy.length ? orderBy : [{ updatedAt: 'desc' }];
}

/** `filter[active]`: `'true'→true`, `'false'→false`, anything else (incl. absent/invalid) → undefined. */
function parseActive(value: string | undefined): boolean | undefined {
  const v = value?.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/**
 * `reveal`: strict bi-state — only the literal `'true'` → `true`; everything else (absent, `'1'`,
 * `'TRUE'`, empty, garbage) → `false`. Shares ONLY the allow-`'true'`-only token check with
 * `parseActive`; unlike `parseActive` (tri-state `boolean | undefined`) this is intentionally a plain
 * `boolean` — a reveal is either requested or not. Reused by the detail route too.
 */
export function parseReveal(value: string | undefined): boolean {
  return value?.trim() === 'true';
}

export function parseCustomerListQuery(raw: Record<string, unknown>): ParsedCustomerListQuery {
  const page = parsePositiveInt(readString(raw, 'page[number]'), 1, 'page[number]');
  const size = parsePositiveInt(readString(raw, 'page[size]'), DEFAULT_PAGE_SIZE, 'page[size]');
  if (size > MAX_PAGE_SIZE) bad('Validation.Failed', `page[size] must not exceed ${MAX_PAGE_SIZE}.`);

  const qRaw = readString(raw, 'filter[q]')?.trim();
  const q = qRaw && qRaw.length > 0 ? qRaw.slice(0, MAX_Q_LENGTH) : undefined;

  const kycRaw = readString(raw, 'filter[kycStatus]')?.trim();
  if (kycRaw && !(kycRaw in KycStatus)) bad('Validation.Failed', `filter[kycStatus] "${kycRaw}" is not a valid KYC status.`);
  const kycStatus = kycRaw ? (kycRaw as KycStatus) : undefined;

  const statusRaw = readString(raw, 'filter[status]')?.trim();
  if (statusRaw && !(statusRaw in CustomerStatus)) bad('Validation.Failed', `filter[status] "${statusRaw}" is not a valid customer status.`);
  const status = statusRaw ? (statusRaw as CustomerStatus) : undefined;

  const active = parseActive(readString(raw, 'filter[active]'));
  const reveal = parseReveal(readString(raw, 'reveal'));

  return { page, size, q, kycStatus, status, active, reveal, orderBy: parseSort(readString(raw, 'sort')) };
}
