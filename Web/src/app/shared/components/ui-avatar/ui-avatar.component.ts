/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type UiAvatarSize = 'xs' | 'sm' | 'md' | 'lg';
export type UiAvatarShape = 'squircle' | 'circle';
export type UiAvatarStatus = 'online' | 'away' | 'offline';
/** Background for the initials fallback: the brand gradient, or a deterministic categorical hue. */
export type UiAvatarColor = 'brand' | 'auto';

/**
 * Approved avatar hues — chart-palette indices for the deterministic fallback, EXCLUDING the
 * off-palette magenta (--chart-4 #fa00ff) and the near-black navy (--chart-5 #343c6a) per the
 * design-review cross-cutting rule (avatar/KPI colour: an approved set, no pure black, no magenta).
 */
const AVATAR_HUES = [1, 2, 3, 6, 7, 8] as const;

/**
 * Avatar — image, initials fallback, or icon (design-system-ui-kit.md §5.12).
 *
 * Sizes xs20 · sm28 · md36 · lg48. Shape `squircle` (--radius-md, default) or
 * `circle` (--radius-pill). Initials render on `--gradient-brand` (`color="brand"`)
 * or a deterministic categorical color hashed from `name` (`color="auto"`).
 * Optional status dot (online/away/offline) sits bottom-end.
 *
 * A11y (§5.12): when an image renders, its `alt` is the person `name`. The
 * initials/icon fallback is decorative (`aria-hidden`) and the host carries an
 * `aria-label` of the `name` with `role="img"` so screen readers announce the
 * person. The status dot exposes a `<title>` (and is otherwise decorative).
 */
@Component({
  selector: 'app-ui-avatar',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './ui-avatar.component.html',
  styleUrl: './ui-avatar.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiAvatarComponent {
  /** Person/entity name — drives initials, alt text and the accessible name. */
  readonly name = input<string | null>(null);
  /** Image URL; when set and loadable, the image renders instead of the fallback. */
  readonly src = input<string | null>(null);
  /** RemixIcon class used when there is no image and no name (e.g. `ri-user-line`). */
  readonly icon = input<string | null>(null);
  readonly size = input<UiAvatarSize>('md');
  readonly shape = input<UiAvatarShape>('squircle');
  /** Background of the initials fallback. */
  readonly color = input<UiAvatarColor>('brand');
  /** Optional presence dot; `null` hides it. */
  readonly status = input<UiAvatarStatus | null>(null);
  /** Visible text for the status dot (already-translated). Falls back to the status key. */
  readonly statusLabel = input<string | null>(null);
  /** Explicit accessible name override; defaults to `name`. */
  readonly ariaLabel = input<string | null>(null);
  readonly id = input<string | null>(null);

  /** Tracks an image load failure so the template falls back to initials/icon. */
  imageFailed = false;

  onImageError(): void {
    this.imageFailed = true;
  }

  /** Whether the <img> element should be shown. */
  get showImage(): boolean {
    return !!this.src() && !this.imageFailed;
  }

  /** Whether the icon fallback (rather than initials) should be shown. */
  get showIcon(): boolean {
    return !this.showImage && !this.initials && !!this.icon();
  }

  /** Whether the initials fallback should be shown. */
  get showInitials(): boolean {
    return !this.showImage && !!this.initials;
  }

  /** Up to two uppercase initials derived from the name. */
  get initials(): string {
    const source = (this.name() ?? '').trim();
    if (!source) return '';
    const parts = source.split(/\s+/).filter(Boolean);
    const first = parts[0].charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
    return (first + last).toUpperCase();
  }

  /** Accessible name for the host (role=img). */
  get accessibleName(): string | null {
    return this.ariaLabel() ?? this.name() ?? null;
  }

  /** Visible status text used in the dot's <title>. */
  get statusText(): string {
    const status = this.status();
    if (!status) return '';
    return this.statusLabel() ?? status;
  }

  /** Deterministic chart-hue index from the name (stable across renders), from the approved set. */
  get hueIndex(): number {
    const source = this.name() ?? '';
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
      // Simple, stable string hash; abs-guarded to a positive bucket.
      hash = (hash << 5) - hash + source.charCodeAt(i);
      hash |= 0;
    }
    return AVATAR_HUES[Math.abs(hash) % AVATAR_HUES.length];
  }

  /** Inline custom properties for the deterministic fallback color. */
  get fallbackStyles(): Record<string, string> {
    if (this.color() !== 'auto' || !this.initials) return {};
    return { '--avatar-fallback': `var(--chart-${this.hueIndex})` };
  }
}
