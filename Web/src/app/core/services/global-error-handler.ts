/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ErrorHandler, Injectable } from '@angular/core';
import { AppErrorService } from '@core/services/app-error.service';

@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  constructor(private readonly errorService: AppErrorService) {}

  handleError(error: unknown): void {
    this.errorService.handleUnknownError(error);
  }
}
