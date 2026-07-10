/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for parseUserListQuery. Pins the server-side validation that bounds
 * enumeration: defaults, the rejected (not clamped) out-of-range page size, non-numeric rejection,
 * and the optional displayName search term.
 */
import { BadRequestException } from '@nestjs/common';
import { parseUserListQuery, USER_LIST_DEFAULT_PAGE_SIZE, USER_LIST_MAX_PAGE_SIZE } from './user-list.query';

describe('parseUserListQuery', () => {
  it('defaults page to 1 and size to the default when omitted', () => {
    expect(parseUserListQuery({})).toEqual({ page: 1, size: USER_LIST_DEFAULT_PAGE_SIZE });
  });

  it('parses provided page + size', () => {
    expect(parseUserListQuery({ 'page[number]': '3', 'page[size]': '10' })).toEqual({ page: 3, size: 10 });
  });

  it('accepts exactly the max page size', () => {
    expect(parseUserListQuery({ 'page[size]': String(USER_LIST_MAX_PAGE_SIZE) }).size).toBe(USER_LIST_MAX_PAGE_SIZE);
  });

  it('REJECTS a page size over the max (bounds bulk enumeration — not silently clamped)', () => {
    expect(() => parseUserListQuery({ 'page[size]': String(USER_LIST_MAX_PAGE_SIZE + 1) })).toThrow(BadRequestException);
  });

  it('rejects a non-numeric page[number]', () => {
    expect(() => parseUserListQuery({ 'page[number]': 'abc' })).toThrow(BadRequestException);
  });

  it('rejects a zero / negative page', () => {
    expect(() => parseUserListQuery({ 'page[number]': '0' })).toThrow(BadRequestException);
  });

  it('trims a search term and drops it when empty', () => {
    expect(parseUserListQuery({ 'filter[q]': '  alice  ' }).q).toBe('alice');
    expect(parseUserListQuery({ 'filter[q]': '   ' }).q).toBeUndefined();
  });

  it('caps an overly long search term', () => {
    const long = 'a'.repeat(500);
    expect(parseUserListQuery({ 'filter[q]': long }).q?.length).toBe(120);
  });

  // readString hardening — Fastify may deliver a repeated key as an array; a non-string primitive is
  // coerced. Both matter because the raw query object is untrusted input.
  it('reads the FIRST element when a bracketed param arrives as a string[] (repeated key)', () => {
    // `?filter[q]=alice&filter[q]=bob` → ['alice','bob']; we take the first.
    expect(parseUserListQuery({ 'filter[q]': ['alice', 'bob'] }).q).toBe('alice');
    // A non-string first element (e.g. [123]) is ignored → no filter.
    expect(parseUserListQuery({ 'filter[q]': [123] }).q).toBeUndefined();
  });

  it('coerces a non-string, non-array primitive via String(v)', () => {
    // A numeric page[number] value (not a string) is stringified then parsed → 3.
    expect(parseUserListQuery({ 'page[number]': 3 }).page).toBe(3);
  });

  it('ignores an explicit null value (treated as absent → default)', () => {
    expect(parseUserListQuery({ 'page[size]': null }).size).toBe(USER_LIST_DEFAULT_PAGE_SIZE);
  });
});
