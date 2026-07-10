/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { animate, group, query, style, transition, trigger } from '@angular/animations';

/**
 * Page transition for the main content outlet (motion-system.md §9).
 *
 * The shell (sidebar, header) never animates on navigation — only the
 * content region inside `.route-host`. The leaving view is pinned
 * absolutely (the host is `position: relative`) so the two views never
 * stack heights, then fades out over 120ms exit-ease while the entering
 * view fades + rises 4px (`--motion-distance-sm`) over 320ms
 * (`--motion-page`) enter-ease. Easings/durations mirror the tokens in
 * `_tokens.scss`; @angular/animations cannot read CSS custom properties,
 * so the values are inlined here and MUST stay in sync with §2.
 *
 * Reduced motion: `main-layout` disables the trigger entirely via
 * `[@.disabled]` when `prefers-reduced-motion` is set (instant swap).
 */
export const routeFade = trigger('routeFade', [
  transition('* => *', [
    query(':leave', [style({ position: 'absolute', inset: 0, width: '100%' })], { optional: true }),
    group([
      query(':leave', [animate('120ms cubic-bezier(0.4, 0, 1, 1)', style({ opacity: 0 }))], {
        optional: true,
      }),
      query(
        ':enter',
        [
          style({ opacity: 0, transform: 'translateY(4px)' }),
          animate(
            '320ms cubic-bezier(0, 0, 0.2, 1)',
            style({ opacity: 1, transform: 'translateY(0)' }),
          ),
        ],
        { optional: true },
      ),
    ]),
  ]),
]);
