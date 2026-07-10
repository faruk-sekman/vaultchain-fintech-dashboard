/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Real render spec: asserts the tabpanel a11y wiring on the DOM and drives the theme/density
 * segmented controls through rendered buttons to prove the output wiring.
 */

import { describe, expect, it } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';

import { SettingsAppearancePanelComponent } from './settings-appearance-panel.component';

function render() {
  TestBed.configureTestingModule({
    imports: [SettingsAppearancePanelComponent, TranslateModule.forRoot()],
  });
  const fixture = TestBed.createComponent(SettingsAppearancePanelComponent);
  const component = fixture.componentInstance;
  component.panelId = 'settings-panel-appearance';
  component.labelledBy = 'settings-tab-appearance';
  component.themeChoice = 'light';
  component.density = 'comfortable';
  component.themeOptions = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'System' },
  ];
  component.densityOptions = [
    { value: 'comfortable', label: 'Comfortable' },
    { value: 'compact', label: 'Compact' },
  ];
  fixture.detectChanges();
  return { fixture, component };
}

function segmentButtons(
  fixture: { nativeElement: HTMLElement },
  index: number,
): HTMLButtonElement[] {
  const segmented = fixture.nativeElement.querySelectorAll('app-ui-segmented')[index];
  return Array.from(segmented?.querySelectorAll('button') ?? []);
}

describe('SettingsAppearancePanelComponent', () => {
  it('renders the tabpanel shell with the a11y wiring and both segmented controls', () => {
    const { fixture } = render();
    const root = fixture.nativeElement.querySelector('[data-testid="settings-panel-appearance"]');

    expect(root?.getAttribute('role')).toBe('tabpanel');
    expect(root?.getAttribute('id')).toBe('settings-panel-appearance');
    expect(root?.getAttribute('aria-labelledby')).toBe('settings-tab-appearance');
    expect(segmentButtons(fixture, 0).map(b => b.textContent?.trim())).toEqual([
      'Light',
      'Dark',
      'System',
    ]);
  });

  it('emits themeChange when a non-active theme segment is clicked', () => {
    const { fixture, component } = render();
    const emitted: string[] = [];
    component.themeChange.subscribe(value => emitted.push(value));

    segmentButtons(fixture, 0)
      .find(b => b.textContent?.includes('Dark'))
      ?.click();

    expect(emitted).toEqual(['dark']);
  });

  it('emits densityChange when a non-active density segment is clicked', () => {
    const { fixture, component } = render();
    const emitted: string[] = [];
    component.densityChange.subscribe(value => emitted.push(value));

    segmentButtons(fixture, 1)
      .find(b => b.textContent?.includes('Compact'))
      ?.click();

    expect(emitted).toEqual(['compact']);
  });
});
