/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for parseRiskAssessmentListQuery (audit 9C). Pagination-only parser — defaults, bounds,
 * the 100 cap, and every 400 path.
 */
import { BadRequestException } from '@nestjs/common';
import { parseRiskAssessmentListQuery } from './risk-assessments.query';

function expectBadRequest(raw: Record<string, unknown>): void {
  expect(() => parseRiskAssessmentListQuery(raw)).toThrow(BadRequestException);
}

describe('parseRiskAssessmentListQuery', () => {
  it('applies defaults for an empty query', () => {
    expect(parseRiskAssessmentListQuery({})).toEqual({ page: 1, size: 25 });
  });

  it('parses valid paging', () => {
    expect(parseRiskAssessmentListQuery({ 'page[number]': '2', 'page[size]': '40' })).toEqual({ page: 2, size: 40 });
  });

  it('treats blank values as defaults', () => {
    expect(parseRiskAssessmentListQuery({ 'page[number]': '', 'page[size]': '   ' })).toEqual({ page: 1, size: 25 });
  });

  it.each(['0', '-1', 'abc', '3.14'])('rejects non-positive-integer page[size]=%s', value => {
    expectBadRequest({ 'page[size]': value });
  });

  it('rejects page[size] over the 100 cap and accepts exactly 100', () => {
    expectBadRequest({ 'page[size]': '250' });
    expect(parseRiskAssessmentListQuery({ 'page[size]': '100' }).size).toBe(100);
  });

  it('rejects an unsafe-integer page value', () => {
    expectBadRequest({ 'page[number]': '99999999999999999999' });
  });

  it('reads the first element of an array param', () => {
    expect(parseRiskAssessmentListQuery({ 'page[number]': ['5', '6'] }).page).toBe(5);
  });
});
