/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class LoadingService {
  private active = 0;
  private emitQueued = false;
  private lastEmitted = false;
  private readonly _loading$ = new BehaviorSubject<boolean>(false);
  readonly loading$ = this._loading$.asObservable();

  start() {
    this.active++;
    this.queueEmit();
  }

  end() {
    this.active = Math.max(0, this.active - 1);
    this.queueEmit();
  }

  private queueEmit() {
    if (this.emitQueued) return;
    this.emitQueued = true;

    queueMicrotask(() => {
      this.emitQueued = false;
      const next = this.active > 0;

      if (next !== this.lastEmitted) {
        this.lastEmitted = next;
        this._loading$.next(next);
      }
    });
  }
}
