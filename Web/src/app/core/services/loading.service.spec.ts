/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect } from 'vitest';
import { LoadingService } from '@core/services/loading.service';

describe('LoadingService', () => {
  it('toggles loading state based on active count', async () => {
    const service = new LoadingService();
    const values: boolean[] = [];
    const sub = service.loading$.subscribe(v => values.push(v));

    service.start();
    await Promise.resolve();

    service.start();
    service.end();
    await Promise.resolve();

    service.end();
    await Promise.resolve();

    expect(values).toEqual([false, true, false]);
    sub.unsubscribe();
  });

  it('coalesces same-tick start and end calls', async () => {
    const service = new LoadingService();
    const values: boolean[] = [];
    const sub = service.loading$.subscribe(v => values.push(v));

    service.start();
    service.end();
    await Promise.resolve();

    expect(values).toEqual([false]);
    sub.unsubscribe();
  });
});
