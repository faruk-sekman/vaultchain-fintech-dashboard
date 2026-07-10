/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiClientService } from './api-client.service';

export interface CurrencyCatalogItem {
  code: string;
  name: string;
  scale: number;
}

@Injectable({ providedIn: 'root' })
export class CatalogApi {
  constructor(private readonly api: ApiClientService) {}

  listCurrencies(): Observable<CurrencyCatalogItem[]> {
    return this.api
      .get<{ data: { items: CurrencyCatalogItem[] } }>('/catalog/currencies')
      .pipe(map(response => response.data.items));
  }
}
