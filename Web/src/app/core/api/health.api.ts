/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from './api-client.service';

export interface HealthStatus {
  status: 'ok';
  uptimeSeconds: number;
}

@Injectable({ providedIn: 'root' })
export class HealthApi {
  constructor(private readonly api: ApiClientService) {}

  getHealth(): Observable<HealthStatus> {
    return this.api.get<{ data: HealthStatus }>('/health').pipe(map(response => response.data));
  }
}
