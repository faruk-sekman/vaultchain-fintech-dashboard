/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { finalize } from 'rxjs/operators';
import { LoadingService } from '@core/services/loading.service';

export const loadingInterceptor: HttpInterceptorFn = (req, next) => {
  const loading = inject(LoadingService);
  if (req.headers.has('x-skip-loading')) return next(req);
  loading.start();
  return next(req).pipe(finalize(() => loading.end()));
};
