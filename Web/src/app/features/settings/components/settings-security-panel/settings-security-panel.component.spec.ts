/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Real render spec: asserts the tabpanel a11y wiring on the DOM, renders the trusted-device list
 * from the `devices` input, and drives askRevoke through the rendered per-device revoke button.
 * AuthService is stubbed for the *appHasPermission admin sections (denied → hidden).
 */

import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';

import { AuthService } from '@core/auth/auth.service';
import type { RememberedDevice } from '@core/api/mfa.api';
import { SettingsSecurityPanelComponent } from './settings-security-panel.component';

const DEVICE: RememberedDevice = {
  id: 'dev-1',
  createdAt: '2026-07-01T00:00:00.000Z',
  expiresAt: '2026-07-31T00:00:00.000Z',
  ipPrefix: '85.100',
};

function render(assign: Partial<SettingsSecurityPanelComponent> = {}) {
  TestBed.configureTestingModule({
    imports: [SettingsSecurityPanelComponent, TranslateModule.forRoot()],
    providers: [{ provide: AuthService, useValue: { hasPermission: () => false } }],
  });
  const fixture = TestBed.createComponent(SettingsSecurityPanelComponent);
  const component = fixture.componentInstance;
  component.panelId = 'settings-panel-security';
  component.labelledBy = 'settings-tab-security';
  component.locale = 'en-US';
  component.mfaReauthForm = new FormGroup({
    password: new FormControl('', { nonNullable: true }),
    code: new FormControl('', { nonNullable: true }),
  });
  component.devices = [DEVICE];
  Object.assign(component, assign);
  fixture.detectChanges();
  return { fixture, component };
}

describe('SettingsSecurityPanelComponent', () => {
  it('renders the tabpanel shell with the a11y wiring and the enable-MFA call to action', () => {
    const { fixture } = render();
    const root = fixture.nativeElement.querySelector('[data-testid="settings-panel-security"]');

    expect(root?.getAttribute('role')).toBe('tabpanel');
    expect(root?.getAttribute('id')).toBe('settings-panel-security');
    expect(root?.getAttribute('aria-labelledby')).toBe('settings-tab-security');
    // mfaEnabled=false → the enable CTA renders; admin sections stay hidden (permission denied).
    expect(fixture.nativeElement.textContent).toContain('mfa.settings.enable');
  });

  it('renders one trusted-device row per device and emits askRevoke with the device id on click', () => {
    const { fixture, component } = render();
    const emitted: string[] = [];
    component.askRevoke.subscribe(id => emitted.push(id));

    const rows = fixture.nativeElement.querySelectorAll('.settings-devices__list li');
    expect(rows.length).toBe(1);

    const revoke = rows[0].querySelector('app-ui-button button') as HTMLButtonElement;
    expect(revoke.disabled).toBe(false);
    revoke.click();

    expect(emitted).toEqual(['dev-1']);
  });

  it('shows the empty state instead of the list when there are no devices', () => {
    const { fixture } = render({ devices: [] });

    expect(fixture.nativeElement.querySelector('.settings-devices__list')).toBeNull();
    expect(fixture.nativeElement.querySelector('.settings-devices__empty')).toBeTruthy();
  });
});
