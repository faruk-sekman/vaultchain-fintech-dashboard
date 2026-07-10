/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Parses + validates the operator notification-list query. Bracketed params arrive as
 * FLAT keys under Fastify's default parser. Invalid input throws a 400 in the standard error envelope
 * (`{ code, message }`). `page[size]` is REJECTED (not clamped) when out of range, bounding
 * the read. Filters: `filter[type]` (enum), `filter[severity]` (enum), `filter[read]` (true/false).
 */
import { BadRequestException } from '@nestjs/common';
import { NotificationSeverity, NotificationType } from '@prisma/client';

export const NOTIFICATION_LIST_MAX_PAGE_SIZE = 100;
export const NOTIFICATION_LIST_DEFAULT_PAGE_SIZE = 20;

export interface ParsedNotificationListQuery {
  page: number;
  size: number;
  type?: NotificationType;
  severity?: NotificationSeverity;
  /** true → only read, false → only unread, undefined → both. */
  read?: boolean;
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

function parseBool(value: string | undefined, field: string): boolean | undefined {
  const v = value?.trim();
  if (v === undefined || v === '') return undefined;
  if (v === 'true') return true;
  if (v === 'false') return false;
  bad('Validation.Failed', `${field} must be "true" or "false".`);
}

export function parseNotificationListQuery(raw: Record<string, unknown>): ParsedNotificationListQuery {
  const page = parsePositiveInt(readString(raw, 'page[number]'), 1, 'page[number]');
  const size = parsePositiveInt(readString(raw, 'page[size]'), NOTIFICATION_LIST_DEFAULT_PAGE_SIZE, 'page[size]');
  if (size > NOTIFICATION_LIST_MAX_PAGE_SIZE) {
    bad('Validation.Failed', `page[size] must not exceed ${NOTIFICATION_LIST_MAX_PAGE_SIZE}.`);
  }

  const typeRaw = readString(raw, 'filter[type]')?.trim();
  if (typeRaw && !(typeRaw in NotificationType)) {
    bad('Validation.Failed', `filter[type] "${typeRaw}" is not a valid notification type.`);
  }
  const type = typeRaw ? (typeRaw as NotificationType) : undefined;

  const sevRaw = readString(raw, 'filter[severity]')?.trim();
  if (sevRaw && !(sevRaw in NotificationSeverity)) {
    bad('Validation.Failed', `filter[severity] "${sevRaw}" is not a valid severity.`);
  }
  const severity = sevRaw ? (sevRaw as NotificationSeverity) : undefined;

  const read = parseBool(readString(raw, 'filter[read]'), 'filter[read]');

  return { page, size, type, severity, read };
}
