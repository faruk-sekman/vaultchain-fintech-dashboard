/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  selector: 'app-ui-skeleton',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-skeleton.component.html',
  styleUrl: './ui-skeleton.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiSkeletonComponent {
  readonly variant = input<'line' | 'block' | 'circle'>('line');
  readonly width = input<string | null>(null);
  readonly height = input<string | null>(null);
  readonly radius = input<string | null>(null);
  readonly animate = input(true);

  get styles(): Record<string, string> {
    const s: Record<string, string> = {};
    const width = this.width();
    const height = this.height();
    const radius = this.radius();
    if (width) s['--skeleton-w'] = width;
    if (height) s['--skeleton-h'] = height;
    if (radius) s['--skeleton-r'] = radius;
    return s;
  }
}
