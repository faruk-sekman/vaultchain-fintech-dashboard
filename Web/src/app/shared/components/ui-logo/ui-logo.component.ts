/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';

/**
 * Brand logo: inlined directly from `assets/img/Vaultchain_Logo.svg` (connected-blocks mark +
 * "Vaultchain" wordmark + "FINTECH OPERATIONS" tagline) — geometry/colours 1:1 with the source
 * file. The component stylesheet adds only what a standalone .svg can't carry: the Space Grotesk
 * font, a dark-theme wordmark colour, and the layer-by-layer entrance via the file's vc-* classes.
 * `showWordmark=false` crops the viewBox to the mark for the collapsed rail. CSS-only animation,
 * disabled under `prefers-reduced-motion` (motion-system §).
 */
@Component({
  selector: 'app-ui-logo',
  standalone: true,
  imports: [RouterLink, TranslateModule],
  templateUrl: './ui-logo.component.html',
  styleUrl: './ui-logo.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiLogoComponent {
  /** Hide the wordmark + tagline (icon-only contexts, e.g. a collapsed rail). */
  readonly showWordmark = input(true);
}
