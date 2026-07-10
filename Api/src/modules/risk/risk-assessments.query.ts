/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Parses + validates the risk-assessment-history paging query (api-endpoint-specifications §7
 * §GET /customers/{id}/risk-assessments). Bracketed flat keys (Fastify default parser); only
 * `page[number]`/`page[size]` are accepted. Invalid input → 400 in the standard error envelope.
 */
import { BadRequestException } from '@nestjs/common';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export interface ParsedRiskAssessmentListQuery {
  page: number;
  size: number;
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

export function parseRiskAssessmentListQuery(raw: Record<string, unknown>): ParsedRiskAssessmentListQuery {
  const page = positiveInt(read(raw, 'page[number]'), 1, 'page[number]');
  const size = positiveInt(read(raw, 'page[size]'), DEFAULT_PAGE_SIZE, 'page[size]');
  if (size > MAX_PAGE_SIZE) bad('Validation.Failed', `page[size] must not exceed ${MAX_PAGE_SIZE}.`);
  return { page, size };
}
