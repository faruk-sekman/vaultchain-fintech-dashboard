/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Parses + validates the customer transaction-list query (api-endpoint-specifications
 * §GET /customers/{id}/transactions). Bracketed flat keys (Fastify default parser). The date
 * range (`filter[occurredFrom]`/`filter[occurredTo]`) is REQUIRED and bounded (≤ 366 days).
 * Invalid input → 400 in the standard error envelope.
 */
import { BadRequestException } from '@nestjs/common';
import { Prisma, TransactionKind, TransactionStatus } from '@prisma/client';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

const SORTABLE: Record<string, keyof Prisma.TransactionOrderByWithRelationInput> = {
  occurredAt: 'occurredAt',
  createdAt: 'createdAt',
};

export interface ParsedTxListQuery {
  page: number;
  size: number;
  kind?: TransactionKind;
  status?: TransactionStatus;
  currency?: string;
  occurredFrom: Date;
  occurredTo: Date;
  orderBy: Prisma.TransactionOrderByWithRelationInput[];
}

function bad(code: string, message: string): never {
  throw new BadRequestException({ code, message });
}

function read(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : String(v);
}

function positiveInt(value: string | undefined, fallback: number, field: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) bad('Validation.Failed', `${field} must be a positive integer.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) bad('Validation.Failed', `${field} must be a positive integer.`);
  return n;
}

function parseDate(value: string | undefined, field: string): Date {
  if (!value || value.trim() === '') bad('Query.DateRangeRequired', `${field} is required (ISO-8601).`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) bad('Validation.Failed', `${field} is not a valid date.`);
  return d;
}

function parseSort(value: string | undefined): Prisma.TransactionOrderByWithRelationInput[] {
  if (!value || value.trim() === '') return [{ occurredAt: 'desc' }];
  const orderBy: Prisma.TransactionOrderByWithRelationInput[] = [];
  for (const tokenRaw of value.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const desc = token.startsWith('-');
    const field = desc ? token.slice(1) : token;
    const column = SORTABLE[field];
    if (!column) bad('Validation.Failed', `sort field "${field}" is not sortable.`);
    orderBy.push({ [column]: desc ? 'desc' : 'asc' });
  }
  return orderBy.length ? orderBy : [{ occurredAt: 'desc' }];
}

export function parseTxListQuery(raw: Record<string, unknown>): ParsedTxListQuery {
  const page = positiveInt(read(raw, 'page[number]'), 1, 'page[number]');
  const size = positiveInt(read(raw, 'page[size]'), DEFAULT_PAGE_SIZE, 'page[size]');
  if (size > MAX_PAGE_SIZE) bad('Validation.Failed', `page[size] must not exceed ${MAX_PAGE_SIZE}.`);

  const occurredFrom = parseDate(read(raw, 'filter[occurredFrom]'), 'filter[occurredFrom]');
  const occurredTo = parseDate(read(raw, 'filter[occurredTo]'), 'filter[occurredTo]');
  if (occurredFrom.getTime() > occurredTo.getTime()) bad('Validation.Failed', 'filter[occurredFrom] must be ≤ filter[occurredTo].');
  if (occurredTo.getTime() - occurredFrom.getTime() > MAX_RANGE_MS) bad('Query.DateRangeRequired', 'The date range must not exceed 366 days.');

  const kindRaw = read(raw, 'filter[kind]')?.trim();
  if (kindRaw && !(kindRaw in TransactionKind)) bad('Validation.Failed', `filter[kind] "${kindRaw}" is invalid.`);
  const statusRaw = read(raw, 'filter[status]')?.trim();
  if (statusRaw && !(statusRaw in TransactionStatus)) bad('Validation.Failed', `filter[status] "${statusRaw}" is invalid.`);
  const currency = read(raw, 'filter[currency]')?.trim() || undefined;

  return {
    page,
    size,
    kind: kindRaw ? (kindRaw as TransactionKind) : undefined,
    status: statusRaw ? (statusRaw as TransactionStatus) : undefined,
    currency,
    occurredFrom,
    occurredTo,
    orderBy: parseSort(read(raw, 'sort')),
  };
}
