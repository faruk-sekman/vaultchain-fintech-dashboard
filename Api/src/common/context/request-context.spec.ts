/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for the SEC-003 operator-id AsyncLocalStorage context.
 */
import { currentOperatorId, runWithRequestContext } from './request-context';

describe('request-context (SEC-003 operator ALS)', () => {
  it('currentOperatorId is null outside any context', () => {
    expect(currentOperatorId()).toBeNull();
  });

  it('exposes the operatorId inside runWithRequestContext', () => {
    expect(runWithRequestContext({ operatorId: 'op-7' }, () => currentOperatorId())).toBe('op-7');
  });

  it('propagates the context across async boundaries', async () => {
    const seen = await runWithRequestContext({ operatorId: 'op-async' }, async () => {
      await Promise.resolve();
      return currentOperatorId();
    });
    expect(seen).toBe('op-async');
  });

  it('carries a null operatorId for the unauthenticated path', () => {
    expect(runWithRequestContext({ operatorId: null }, () => currentOperatorId())).toBeNull();
  });

  it('does not leak the context after the callback returns', () => {
    runWithRequestContext({ operatorId: 'op-x' }, () => currentOperatorId());
    expect(currentOperatorId()).toBeNull();
  });
});
