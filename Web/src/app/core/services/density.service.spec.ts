/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { DensityService } from '@core/services/density.service';

describe('DensityService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to comfortable when storage is empty', () => {
    const service = TestBed.runInInjectionContext(() => new DensityService());
    expect(service.density()).toBe('comfortable');
  });

  it('initializes from a persisted compact preference', () => {
    localStorage.setItem('density', 'compact');
    const service = TestBed.runInInjectionContext(() => new DensityService());
    expect(service.density()).toBe('compact');
  });

  it('ignores an unknown stored value and falls back to comfortable', () => {
    localStorage.setItem('density', 'cozy');
    const service = TestBed.runInInjectionContext(() => new DensityService());
    expect(service.density()).toBe('comfortable');
  });

  it('persists changes to localStorage', () => {
    const service = TestBed.runInInjectionContext(() => new DensityService());
    service.setDensity('compact');
    expect(service.density()).toBe('compact');
    expect(localStorage.getItem('density')).toBe('compact');

    service.setDensity('comfortable');
    expect(localStorage.getItem('density')).toBe('comfortable');
  });

  it('handles read errors gracefully (preference defaults, no crash)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('nope');
    });
    const service = TestBed.runInInjectionContext(() => new DensityService());
    expect(service.density()).toBe('comfortable');
    spy.mockRestore();
  });

  it('keeps the selection in memory when persisting fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('no storage');
    });
    const service = TestBed.runInInjectionContext(() => new DensityService());
    service.setDensity('compact');
    expect(service.density()).toBe('compact');
  });

  it('stays usable when window is undefined (storage unavailable)', () => {
    const service = TestBed.runInInjectionContext(() => new DensityService());
    const originalWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = undefined;

    service.setDensity('compact');
    expect(service.density()).toBe('compact');
    expect((service as unknown as { readInitialDensity(): string }).readInitialDensity()).toBe(
      'comfortable',
    );

    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it('falls back when the localStorage accessor itself throws', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked accessor');
    });

    const service = TestBed.runInInjectionContext(() => new DensityService());

    expect(service.density()).toBe('comfortable');
  });

  it('falls back when the localStorage accessor returns null', () => {
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue(null as unknown as Storage);

    const service = TestBed.runInInjectionContext(() => new DensityService());

    expect(service.density()).toBe('comfortable');
    service.setDensity('compact');
    expect(service.density()).toBe('compact');
  });
});
