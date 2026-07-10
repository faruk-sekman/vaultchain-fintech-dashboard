/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { ToastService } from '@core/services/toast.service';

class ToastrMock {
  success = vi.fn();
  error = vi.fn();
  info = vi.fn();
  warning = vi.fn();
}

describe('ToastService', () => {
  it('delegates to toastr methods', () => {
    const toastr = new ToastrMock();
    const service = new ToastService(toastr as any);

    service.success('ok');
    service.error('err');
    service.info('info');
    service.warning('warn');

    expect(toastr.success).toHaveBeenCalledWith('ok');
    expect(toastr.error).toHaveBeenCalledWith('err');
    expect(toastr.info).toHaveBeenCalledWith('info');
    expect(toastr.warning).toHaveBeenCalledWith('warn');
  });
});
