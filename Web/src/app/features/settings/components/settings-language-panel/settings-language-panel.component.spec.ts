/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Real render spec: asserts the tabpanel a11y wiring on the DOM and drives the language
 * segmented control through a rendered button to prove the output wiring.
 */

import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';

import { SettingsLanguagePanelComponent } from './settings-language-panel.component';

function render() {
  TestBed.configureTestingModule({
    imports: [SettingsLanguagePanelComponent, TranslateModule.forRoot()],
  });
  const fixture = TestBed.createComponent(SettingsLanguagePanelComponent);
  const component = fixture.componentInstance;
  component.panelId = 'settings-panel-language';
  component.labelledBy = 'settings-tab-language';
  component.currentLang = 'tr';
  component.langOptions = [
    { value: 'tr', label: 'Türkçe' },
    { value: 'en', label: 'English' },
  ];
  fixture.detectChanges();
  return { fixture, component };
}

describe('SettingsLanguagePanelComponent', () => {
  it('renders the tabpanel shell with the a11y wiring and both language segments', () => {
    const { fixture } = render();
    const root = fixture.nativeElement.querySelector('[data-testid="settings-panel-language"]');
    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('app-ui-segmented button'),
    ).map(b => (b as HTMLButtonElement).textContent?.trim());

    expect(root?.getAttribute('role')).toBe('tabpanel');
    expect(root?.getAttribute('id')).toBe('settings-panel-language');
    expect(root?.getAttribute('aria-labelledby')).toBe('settings-tab-language');
    expect(labels).toEqual(['Türkçe', 'English']);
  });

  it('emits langChange when the non-active language segment is clicked', () => {
    const { fixture, component } = render();
    const emitted: string[] = [];
    component.langChange.subscribe(value => emitted.push(value));

    const english = Array.from(
      fixture.nativeElement.querySelectorAll('app-ui-segmented button'),
    ).find(b => (b as HTMLButtonElement).textContent?.includes('English')) as HTMLButtonElement;
    english.click();

    expect(emitted).toEqual(['en']);
  });
});
