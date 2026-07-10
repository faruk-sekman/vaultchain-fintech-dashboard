/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Parses + validates the admin user-list query. Mirrors customers.query: bracketed
 * params (`page[number]`, `page[size]`, `filter[q]`) arrive as FLAT keys under Fastify's default query
 * parser, so we read them directly — no `qs` dependency. Invalid input throws a 400 in the standard
 * error-envelope shape (`{ code, message }`).
 *
 * Enumeration is bounded server-side: `page[size]` is REJECTED (not silently clamped) when it exceeds
 * MAX_PAGE_SIZE, so a caller cannot pull the whole user table in one bulk page.
 */
import { BadRequestException } from '@nestjs/common';

/** Hard ceiling on page size — bounds bulk enumeration of the user table. */
export const USER_LIST_MAX_PAGE_SIZE = 100;
/** Default page size when the caller omits `page[size]`. */
export const USER_LIST_DEFAULT_PAGE_SIZE = 25;
/** Cap on the free-text search term length (defensive — a search box, not an essay). */
const MAX_Q_LENGTH = 120;

export interface ParsedUserListQuery {
  page: number;
  size: number;
  /** Free-text search over displayName (case-insensitive contains); undefined = no filter. */
  q?: string;
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

export function parseUserListQuery(raw: Record<string, unknown>): ParsedUserListQuery {
  const page = parsePositiveInt(readString(raw, 'page[number]'), 1, 'page[number]');
  const size = parsePositiveInt(readString(raw, 'page[size]'), USER_LIST_DEFAULT_PAGE_SIZE, 'page[size]');
  if (size > USER_LIST_MAX_PAGE_SIZE) bad('Validation.Failed', `page[size] must not exceed ${USER_LIST_MAX_PAGE_SIZE}.`);

  const qRaw = readString(raw, 'filter[q]')?.trim();
  const q = qRaw && qRaw.length > 0 ? qRaw.slice(0, MAX_Q_LENGTH) : undefined;

  return { page, size, q };
}
