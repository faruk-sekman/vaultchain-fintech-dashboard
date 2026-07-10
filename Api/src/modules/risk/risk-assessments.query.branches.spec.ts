/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-coverage unit tests for parseRiskAssessmentListQuery (TASK-API risk history) that
 * complement risk-assessments.query.spec.ts. These pin the remaining branches in the `read`
 * coercion helper: an array whose first element is not a string (→ undefined → default), and a
 * non-string scalar coerced via String(v).
 */
import { parseRiskAssessmentListQuery } from './risk-assessments.query';

describe('parseRiskAssessmentListQuery — coercion branches', () => {
  it('treats an array whose first element is not a string as undefined (default page)', () => {
    // page[number] is [ {} ] → read() returns undefined → default 1.
    const result = parseRiskAssessmentListQuery({ 'page[number]': [{ x: 1 }] as unknown as string[] });
    expect(result.page).toBe(1);
  });

  it('coerces a non-string scalar via String(v) for page[size]', () => {
    // page[size] is the number 40 → String(40) = "40" → parsed as 40.
    const result = parseRiskAssessmentListQuery({ 'page[size]': 40 as unknown as string });
    expect(result.size).toBe(40);
  });

  it('coerces a non-string scalar page[number] via String(v)', () => {
    const result = parseRiskAssessmentListQuery({ 'page[number]': 3 as unknown as string });
    expect(result.page).toBe(3);
  });
});
