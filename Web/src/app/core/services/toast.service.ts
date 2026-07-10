/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable } from '@angular/core';
import { ToastrService } from 'ngx-toastr';

@Injectable({ providedIn: 'root' })
export class ToastService {
  constructor(private readonly toastr: ToastrService) {}

  success(text: string) {
    this.toastr.success(text);
  }
  error(text: string) {
    this.toastr.error(text);
  }
  info(text: string) {
    this.toastr.info(text);
  }
  warning(text: string) {
    this.toastr.warning(text);
  }
}
