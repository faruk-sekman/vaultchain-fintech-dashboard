/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UiBadgeColor =
  | 'gray'
  | 'red'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink'
  | 'custom'
  | 'teal'
  | 'cyan'
  | 'fuchsia'
  | 'zinc';

export type UiBadgeIconPosition = 'left' | 'right';

export type ClassValue = string | string[] | Set<string> | { [csClass: string]: unknown };

const COLOR_CLASSES: Record<Exclude<UiBadgeColor, 'custom'>, string> = {
  gray: 'ui-badge--gray',
  red: 'ui-badge--red',
  yellow: 'ui-badge--yellow',
  green: 'ui-badge--green',
  blue: 'ui-badge--blue',
  indigo: 'ui-badge--indigo',
  purple: 'ui-badge--purple',
  pink: 'ui-badge--pink',
  teal: 'ui-badge--teal',
  cyan: 'ui-badge--cyan',
  fuchsia: 'ui-badge--fuchsia',
  zinc: 'ui-badge--zinc',
};
//""
@Component({
  selector: 'app-ui-badge',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-badge.component.html',
  styleUrl: './ui-badge.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiBadgeComponent {
  readonly text = input<string | null>(null);
  readonly icon = input<string | null>(null);
  readonly iconPosition = input<UiBadgeIconPosition>('left');
  readonly dot = input(false);
  readonly color = input<UiBadgeColor>('gray');
  readonly colorClass = input<string | null>(null);
  readonly badgeClass = input<ClassValue | null>(null);
  readonly iconClass = input<ClassValue | null>(null);
  readonly dotClass = input<ClassValue | null>(null);
  readonly id = input<string | null>(null);

  get badgeClassString(): string {
    return ['ui-badge', this.baseClass, this.resolvedColorClass].filter(Boolean).join(' ');
  }

  get dotClassString(): string {
    return ['ui-badge__dot', this.dotBaseClass].filter(Boolean).join(' ');
  }

  get iconClassString(): string {
    return ['ui-badge__icon', this.iconBaseClass, this.icon()].filter(Boolean).join(' ');
  }

  get hasText(): boolean {
    return this.text() !== null && this.text() !== undefined;
  }

  private get baseClass(): string {
    // v2 §4: status badges are soft pills (radius-pill), icon/label kept (never colour-only).
    return 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap';
  }

  private get dotBaseClass(): string {
    return 'inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-current';
  }

  private get iconBaseClass(): string {
    return 'leading-none shrink-0';
  }

  private get resolvedColorClass(): string {
    const colorClass = this.colorClass();
    if (colorClass) return colorClass;
    const color = this.color();
    if (color === 'custom') return '';
    return COLOR_CLASSES[color];
  }
}
