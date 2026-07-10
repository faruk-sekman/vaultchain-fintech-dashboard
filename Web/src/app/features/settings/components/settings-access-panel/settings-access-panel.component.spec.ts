/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Real render spec: asserts the tabpanel a11y wiring on the DOM and that the access table rows
 * render from the `accessRows` input (this panel is presentation-only — it has no outputs).
 */

import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';

import { SettingsAccessPanelComponent } from './settings-access-panel.component';

function render(overrides: Partial<SettingsAccessPanelComponent> = {}) {
  TestBed.configureTestingModule({
    imports: [SettingsAccessPanelComponent, TranslateModule.forRoot()],
  });
  const fixture = TestBed.createComponent(SettingsAccessPanelComponent);
  const component = fixture.componentInstance;
  component.panelId = 'settings-panel-access';
  component.labelledBy = 'settings-tab-access';
  component.accountPermissionsCount = 3;
  component.accountResourceCount = 2;
  component.sensitiveCount = 1;
  component.uptimeParts = { hours: 4, minutes: 20 };
  component.accessCategories = [{ key: 'customer', labelKey: 'settings.access.cat.customer' }];
  component.accessRows = [
    {
      resource: 'customers',
      category: 'customer',
      scopes: [
        { code: 'customers.read', action: 'read', sensitive: false },
        { code: 'customers.pii.reveal', action: 'pii.reveal', sensitive: true },
      ],
    },
  ];
  Object.assign(component, overrides);
  fixture.detectChanges();
  return { fixture, component };
}

describe('SettingsAccessPanelComponent', () => {
  it('renders the tabpanel shell with the a11y wiring and the aside facts', () => {
    const { fixture } = render();
    const root = fixture.nativeElement.querySelector('[data-testid="settings-panel-access"]');
    const facts = fixture.nativeElement.querySelector('[data-testid="settings-access-facts"]');

    expect(root?.getAttribute('role')).toBe('tabpanel');
    expect(root?.getAttribute('id')).toBe('settings-panel-access');
    expect(root?.getAttribute('aria-labelledby')).toBe('settings-tab-access');
    expect(facts?.textContent).toContain('3'); // grantedPermissions count renders
  });

  it('renders one access-table row per accessRows entry with its scopes and count', () => {
    const { fixture } = render();
    const table = fixture.nativeElement.querySelector('[data-testid="settings-access-table"]');
    const row = table?.querySelector('tbody tr');

    expect(row?.querySelector('code')?.textContent).toBe('customers');
    expect(row?.querySelectorAll('.access-scope').length).toBe(2);
    expect(row?.querySelector('.access-scope--sensitive')?.textContent).toContain('pii.reveal');
    expect(row?.querySelector('.access-count')?.textContent).toBe('2');
  });

  it('falls back to the empty state when no permissions are granted', () => {
    const { fixture } = render({ accessRows: [] });

    expect(fixture.nativeElement.querySelector('[data-testid="settings-access-table"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('.settings-access-empty')).toBeTruthy();
  });
});
