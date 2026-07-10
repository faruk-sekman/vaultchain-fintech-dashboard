/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

export interface PaginatedResponse<T> {
  page: number;
  pageSize: number;
  total: number;
  data: T[];
}
