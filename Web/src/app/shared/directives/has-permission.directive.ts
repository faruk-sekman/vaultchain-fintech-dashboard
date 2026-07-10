/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Structural directive that renders its host element ONLY when the loaded operator holds the required
 * permission code(s) — the single, reusable FE permission gate (defense-in-depth;
 * the backend `PermissionsGuard` remains the real authority and returns 403). Hides controls an
 * under-privileged operator would only be 403'd on, so they are never offered.
 *
 * Reactive: the check runs inside an `effect()`, and `AuthService.hasPermission()` transitively reads
 * the `principal` signal, so the gate re-evaluates automatically on login / silent-refresh / logout —
 * fail-closed (hidden) until the principal loads. Accepts one code or an array (ALL required, AND).
 *
 *   <button *appHasPermission="'customers.delete'">Delete</button>
 *   <a *appHasPermission="'customers.read'" routerLink="/customers">…</a>
 */
import {
  Directive,
  Input,
  TemplateRef,
  ViewContainerRef,
  effect,
  inject,
  signal,
} from '@angular/core';
import { AuthService } from '@core/auth/auth.service';

@Directive({
  selector: '[appHasPermission]',
  standalone: true,
})
export class HasPermissionDirective {
  private readonly auth = inject(AuthService);
  private readonly templateRef = inject(TemplateRef<unknown>);
  private readonly viewContainer = inject(ViewContainerRef);

  /** The required permission code(s); a signal so the effect re-runs when the binding changes. */
  private readonly required = signal<readonly string[]>([]);
  private rendered = false;

  @Input({ required: true })
  set appHasPermission(value: string | readonly string[]) {
    this.required.set(typeof value === 'string' ? [value] : value);
  }

  constructor() {
    // Re-evaluate when the principal's permissions change (hasPermission reads the principal signal)
    // OR when the required codes change. Fail-closed: empty required ⇒ never rendered.
    effect(() => {
      const codes = this.required();
      const allowed = codes.length > 0 && codes.every(code => this.auth.hasPermission(code));
      this.toggle(allowed);
    });
  }

  private toggle(allowed: boolean): void {
    if (allowed && !this.rendered) {
      this.viewContainer.createEmbeddedView(this.templateRef);
      this.rendered = true;
    } else if (!allowed && this.rendered) {
      this.viewContainer.clear();
      this.rendered = false;
    }
  }
}
