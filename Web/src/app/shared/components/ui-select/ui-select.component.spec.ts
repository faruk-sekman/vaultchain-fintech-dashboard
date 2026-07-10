/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Direct (no-DOM) smoke tests. The select is presentational (binds a FormControl + renders options);
 * these pin its defaults and that it accepts bound options/control. Honest coverage of the contract
 * surface, not business logic.
 */
import { describe, it, expect } from 'vitest';
import { FormControl } from '@angular/forms';
import { UiSelectComponent } from './ui-select.component';

describe('UiSelectComponent', () => {
  it('has presentational defaults', () => {
    const c = new UiSelectComponent();
    expect(c.options).toEqual([]);
    expect(c.readOnly).toBe(false);
    expect(c.disabled).toBe(false);
  });

  it('accepts a bound control and options', () => {
    const c = new UiSelectComponent();
    c.control = new FormControl('try');
    c.options = [
      { value: 'try', label: 'TRY' },
      { value: 'usd', label: 'USD' },
    ];
    expect(c.control.value).toBe('try');
    expect(c.options).toHaveLength(2);
  });
});
