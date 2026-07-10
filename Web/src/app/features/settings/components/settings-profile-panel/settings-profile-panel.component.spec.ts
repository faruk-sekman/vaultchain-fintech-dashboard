/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Real render spec: the panel is created via TestBed, the tabpanel a11y wiring is asserted on the
 * DOM, and the save action is driven through the rendered button (enabled only when valid+dirty).
 */

import { describe, expect, it } from 'vitest';
import { ChangeDetectorRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, FormGroup } from '@angular/forms';
import { TranslateModule } from '@ngx-translate/core';

import { SettingsProfilePanelComponent } from './settings-profile-panel.component';

/** The panel is OnPush: form-state mutations need an explicit mark-for-check before re-render. */
function rerender(fixture: ComponentFixture<SettingsProfilePanelComponent>) {
  fixture.componentRef.injector.get(ChangeDetectorRef).markForCheck();
  fixture.detectChanges();
}

function createProfileForm() {
  return new FormGroup({
    displayName: new FormControl('Operator One', { nonNullable: true }),
    email: new FormControl('o***@e***.com', { nonNullable: true }),
    phone: new FormControl('', { nonNullable: true }),
    jobTitle: new FormControl('', { nonNullable: true }),
  });
}

function render() {
  TestBed.configureTestingModule({
    imports: [SettingsProfilePanelComponent, TranslateModule.forRoot()],
  });
  const fixture = TestBed.createComponent(SettingsProfilePanelComponent);
  const component = fixture.componentInstance;
  component.panelId = 'settings-panel-profile';
  component.labelledBy = 'settings-tab-profile';
  component.profileForm = createProfileForm();
  fixture.detectChanges();
  return { fixture, component };
}

describe('SettingsProfilePanelComponent', () => {
  it('renders the tabpanel shell with the a11y wiring and the profile form controls', () => {
    const { fixture } = render();
    const root = fixture.nativeElement.querySelector('[data-testid="settings-panel-profile"]');

    expect(root?.getAttribute('role')).toBe('tabpanel');
    expect(root?.getAttribute('id')).toBe('settings-panel-profile');
    expect(root?.getAttribute('aria-labelledby')).toBe('settings-tab-profile');
    expect(
      fixture.nativeElement.querySelector('[data-testid="settings-profile-name"]'),
    ).toBeTruthy();
  });

  it('keeps save disabled while pristine, then emits saveProfile on click once valid + dirty', () => {
    const { fixture, component } = render();
    const saveButton = fixture.nativeElement.querySelector(
      '[data-testid="settings-profile-save"] button',
    ) as HTMLButtonElement;
    let saves = 0;
    component.saveProfile.subscribe(() => saves++);

    expect(saveButton.disabled).toBe(true); // pristine form → no-op save is unreachable
    saveButton.click();
    expect(saves).toBe(0);

    component.profileForm.controls.displayName.setValue('Operator Two');
    component.profileForm.markAsDirty();
    rerender(fixture);

    expect(saveButton.disabled).toBe(false);
    saveButton.click();
    expect(saves).toBe(1);
  });

  it('emits cancelProfile from the rendered cancel button when the form is dirty', () => {
    const { fixture, component } = render();
    component.profileForm.markAsDirty();
    rerender(fixture);
    let cancels = 0;
    component.cancelProfile.subscribe(() => cancels++);

    const buttons = fixture.nativeElement.querySelectorAll(
      '.settings-form-footer__actions button',
    ) as NodeListOf<HTMLButtonElement>;
    buttons[0].click(); // the ghost cancel button precedes save

    expect(cancels).toBe(1);
  });
});
