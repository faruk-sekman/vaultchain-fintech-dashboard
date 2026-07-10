/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for parseNotificationListQuery. Pins defaults, the rejected out-of-range
 * page size, and the type/severity/read filters (including invalid-enum + invalid-bool 400s).
 */
import { BadRequestException } from '@nestjs/common';
import {
  NOTIFICATION_LIST_DEFAULT_PAGE_SIZE,
  NOTIFICATION_LIST_MAX_PAGE_SIZE,
  parseNotificationListQuery,
} from './notification-list.query';

describe('parseNotificationListQuery', () => {
  it('defaults page + size', () => {
    expect(parseNotificationListQuery({})).toEqual({
      page: 1,
      size: NOTIFICATION_LIST_DEFAULT_PAGE_SIZE,
      type: undefined,
      severity: undefined,
      read: undefined,
    });
  });

  it('REJECTS a page size over the max', () => {
    expect(() => parseNotificationListQuery({ 'page[size]': String(NOTIFICATION_LIST_MAX_PAGE_SIZE + 1) })).toThrow(
      BadRequestException,
    );
  });

  it('parses a valid type + severity filter', () => {
    const parsed = parseNotificationListQuery({ 'filter[type]': 'SECURITY_ALERT', 'filter[severity]': 'critical' });
    expect(parsed.type).toBe('SECURITY_ALERT');
    expect(parsed.severity).toBe('critical');
  });

  it('rejects an invalid type', () => {
    expect(() => parseNotificationListQuery({ 'filter[type]': 'NOPE' })).toThrow(BadRequestException);
  });

  it('rejects an invalid severity', () => {
    expect(() => parseNotificationListQuery({ 'filter[severity]': 'fatal' })).toThrow(BadRequestException);
  });

  it('parses filter[read] true/false', () => {
    expect(parseNotificationListQuery({ 'filter[read]': 'true' }).read).toBe(true);
    expect(parseNotificationListQuery({ 'filter[read]': 'false' }).read).toBe(false);
  });

  it('leaves read undefined when absent', () => {
    expect(parseNotificationListQuery({}).read).toBeUndefined();
  });

  it('rejects a non-bool filter[read]', () => {
    expect(() => parseNotificationListQuery({ 'filter[read]': 'maybe' })).toThrow(BadRequestException);
  });

  it('rejects a non-numeric page[number] / page[size]', () => {
    expect(() => parseNotificationListQuery({ 'page[number]': 'abc' })).toThrow(BadRequestException);
    expect(() => parseNotificationListQuery({ 'page[size]': '1.5' })).toThrow(BadRequestException);
  });

  it('rejects a zero / negative page (parsed but < 1)', () => {
    expect(() => parseNotificationListQuery({ 'page[number]': '0' })).toThrow(BadRequestException);
  });

  // readString hardening — a repeated bracket key arrives as string[]; a non-string primitive is coerced.
  it('reads the FIRST element when a param arrives as a string[]', () => {
    // `?filter[severity]=critical&filter[severity]=info` → ['critical','info']; take the first.
    expect(parseNotificationListQuery({ 'filter[severity]': ['critical', 'info'] }).severity).toBe('critical');
    // A non-string first element is ignored → the filter is treated as absent.
    expect(parseNotificationListQuery({ 'filter[type]': [123] }).type).toBeUndefined();
  });

  it('coerces a non-string, non-array primitive via String(v)', () => {
    // A numeric page[number] value is stringified then parsed → 2.
    expect(parseNotificationListQuery({ 'page[number]': 2 }).page).toBe(2);
  });
});
