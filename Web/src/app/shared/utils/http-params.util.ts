/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { HttpParams } from '@angular/common/http';

export type HttpParamValue = string | number | boolean | null | undefined;
export type HttpParamsInput = Record<string, HttpParamValue>;

export function toHttpParams(params: HttpParamsInput | undefined): HttpParams {
  let httpParams = new HttpParams();
  if (!params) return httpParams;

  Object.entries(params).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    httpParams = httpParams.set(k, String(v));
  });

  return httpParams;
}
