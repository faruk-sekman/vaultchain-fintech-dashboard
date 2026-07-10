/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const controller = new HealthController();

  it('reports ok status', () => {
    const result = controller.check();
    expect(result.status).toBe('ok');
  });

  it('reports a non-negative integer uptime', () => {
    const result = controller.check();
    expect(Number.isInteger(result.uptimeSeconds)).toBe(true);
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});
