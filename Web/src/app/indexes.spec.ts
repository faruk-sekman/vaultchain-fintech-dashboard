/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect } from 'vitest';
import * as core from '@core/index';
import * as shared from '@shared/index';
import * as customersState from '@features/customers/state/index';
import * as dashboardState from '@features/dashboard/state/index';

describe('barrel index files', () => {
  it('exports modules without crashing', () => {
    expect(core).toBeDefined();
    expect(shared).toBeDefined();
    expect(customersState).toBeDefined();
    expect(dashboardState).toBeDefined();
  });
});
