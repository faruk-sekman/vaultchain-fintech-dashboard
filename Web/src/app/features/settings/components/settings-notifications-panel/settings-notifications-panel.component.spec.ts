/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Real render spec: asserts the tabpanel a11y wiring on the DOM, that the three preference
 * switches render bound to the form, and that view-all emits through the rendered button.
 */

import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';

import { SettingsNotificationsPanelComponent } from './settings-notifications-panel.component';

function render() {
  TestBed.configureTestingModule({
    imports: [SettingsNotificationsPanelComponent, TranslateModule.forRoot()],
  });
  const fixture = TestBed.createComponent(SettingsNotificationsPanelComponent);
  const component = fixture.componentInstance;
  component.panelId = 'settings-panel-notifications';
  component.labelledBy = 'settings-tab-notifications';
  component.notificationsForm = new FormGroup({
    productUpdates: new FormControl(true, { nonNullable: true }),
    securityAlerts: new FormControl(true, { nonNullable: true }),
    weeklyDigest: new FormControl(false, { nonNullable: true }),
  });
  fixture.detectChanges();
  return { fixture, component };
}

describe('SettingsNotificationsPanelComponent', () => {
  it('renders the tabpanel shell with the a11y wiring and the three preference switches', () => {
    const { fixture } = render();
    const root = fixture.nativeElement.querySelector(
      '[data-testid="settings-panel-notifications"]',
    );
    const switches = fixture.nativeElement.querySelectorAll('button[role="switch"]');

    expect(root?.getAttribute('role')).toBe('tabpanel');
    expect(root?.getAttribute('id')).toBe('settings-panel-notifications');
    expect(root?.getAttribute('aria-labelledby')).toBe('settings-tab-notifications');
    expect(switches.length).toBe(3);
  });

  it('reflects the bound form values in the rendered switch states', () => {
    const { fixture } = render();
    const digest = fixture.nativeElement.querySelector(
      '[data-testid="settings-notifications-digest"] button[role="switch"]',
    ) as HTMLButtonElement;

    expect(digest.getAttribute('aria-checked')).toBe('false'); // weeklyDigest starts off
  });

  it('emits viewAllNotifications when the rendered view-all button is clicked', () => {
    const { fixture, component } = render();
    let clicks = 0;
    component.viewAllNotifications.subscribe(() => clicks++);

    const viewAll = fixture.nativeElement.querySelector(
      '.settings-actions app-ui-button button',
    ) as HTMLButtonElement;
    viewAll.click();

    expect(clicks).toBe(1);
  });
});
