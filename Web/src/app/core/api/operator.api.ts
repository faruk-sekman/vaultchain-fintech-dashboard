/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from './api-client.service';

export interface OperatorProfile {
  displayName: string | null;
  email: string;
  phone: string | null;
  jobTitle: string | null;
}

export interface UpdateOperatorProfile {
  displayName?: string;
  phone?: string;
  jobTitle?: string;
}

export interface NotificationPreferences {
  productUpdates: boolean;
  securityAlerts: boolean;
  weeklyDigest: boolean;
}

@Injectable({ providedIn: 'root' })
export class OperatorApi {
  constructor(private readonly api: ApiClientService) {}

  getProfile(): Observable<OperatorProfile> {
    return this.api
      .get<{ data: OperatorProfile }>('/operator/profile')
      .pipe(map(response => response.data));
  }

  updateProfile(body: UpdateOperatorProfile): Observable<OperatorProfile> {
    return this.api
      .patch<{ data: OperatorProfile }>('/operator/profile', body)
      .pipe(map(response => response.data));
  }

  getNotificationPreferences(): Observable<NotificationPreferences> {
    return this.api
      .get<{ data: NotificationPreferences }>('/operator/notification-preferences')
      .pipe(map(response => response.data));
  }

  updateNotificationPreferences(
    body: Partial<NotificationPreferences>,
  ): Observable<NotificationPreferences> {
    return this.api
      .patch<{ data: NotificationPreferences }>('/operator/notification-preferences', body)
      .pipe(map(response => response.data));
  }
}
