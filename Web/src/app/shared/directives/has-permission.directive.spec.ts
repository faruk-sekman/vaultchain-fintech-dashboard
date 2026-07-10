/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { describe, it, expect } from 'vitest';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HasPermissionDirective } from './has-permission.directive';
import { AuthService } from '@core/auth/auth.service';

/** AuthService stub backed by a signal so the directive's `effect()` re-runs when grants change. */
function makeAuth(initial: string[] = []) {
  const perms = signal<string[]>(initial);
  const service = {
    hasPermission: (code: string) => perms().includes(code),
  } as unknown as AuthService;
  return { service, setPerms: (p: string[]) => perms.set(p) };
}

@Component({
  standalone: true,
  imports: [HasPermissionDirective],
  template: `<span *appHasPermission="perm" id="gated">visible</span>`,
})
class HostComponent {
  perm: string | readonly string[] = 'customers.delete';
}

function setup(initial: string[], perm: string | readonly string[] = 'customers.delete') {
  const auth = makeAuth(initial);
  TestBed.configureTestingModule({
    imports: [HostComponent],
    providers: [{ provide: AuthService, useValue: auth.service }],
  });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.componentInstance.perm = perm;
  fixture.detectChanges();
  const present = () => !!fixture.nativeElement.querySelector('#gated');
  return { fixture, auth, present };
}

describe('HasPermissionDirective', () => {
  it('renders the element when the operator holds the permission', () => {
    const { present } = setup(['customers.delete']);
    expect(present()).toBe(true);
  });

  it('hides the element when the permission is absent (fail-closed UX)', () => {
    const { present } = setup(['customers.manage']); // has manage, NOT delete
    expect(present()).toBe(false);
  });

  it('hides until the principal loads, then reveals when the grant arrives (reactive)', () => {
    const { fixture, auth, present } = setup([]); // no permissions yet (e.g. pre-refresh)
    expect(present()).toBe(false);
    auth.setPerms(['customers.delete']);
    fixture.detectChanges();
    expect(present()).toBe(true);
  });

  it('re-hides when the permission is revoked (e.g. logout / role downscope on refresh)', () => {
    const { fixture, auth, present } = setup(['customers.delete']);
    expect(present()).toBe(true);
    auth.setPerms([]);
    fixture.detectChanges();
    expect(present()).toBe(false);
  });

  it('renders an array binding only when ALL codes are held (AND semantics)', () => {
    const { present } = setup(['roles.read', 'roles.manage'], ['roles.read', 'roles.manage']);
    expect(present()).toBe(true);
  });

  it('hides an array binding when only some codes are held', () => {
    const { present } = setup(['roles.read'], ['roles.read', 'roles.manage']);
    expect(present()).toBe(false);
  });

  it('hides for an empty required list (never renders without an explicit grant)', () => {
    const { present } = setup(['customers.delete'], []);
    expect(present()).toBe(false);
  });
});
