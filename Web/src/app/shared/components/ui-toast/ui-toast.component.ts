/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Custom ngx-toastr toast. The toast BODY is the shared `app-ui-alert`,
 * rendered inside the toast host — so a toast is LITERALLY our in-app alert design: same markup,
 * tokens, flex layout, icon, and dismiss. This replaces CSS-theming ngx-toastr's default markup, which
 * caused icon/close misalignment ("kaymalar"). We extend ngx-toastr `Toast` to keep its lifecycle
 * (timeout, hover-to-stick, tap-to-dismiss, opacity fade-in) and map the toast type to a ui-alert
 * variant. The float-wrapper (radius + shadow + spacing) lives in `src/styles/_toastr.scss`.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { Toast } from 'ngx-toastr';
import { UiAlertComponent, UiAlertType } from '@shared/components/ui-alert/ui-alert.component';

@Component({
  selector: '[ui-toast-component]',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiAlertComponent, TranslateModule],
  // Host bindings mirror ngx-toastr's own Toast (its @Component `host` does not inherit): the type
  // classes, the hide-while-queued display, hover/tap dismiss, and the opacity fade-in via Angular's
  // `animate.enter` (no transform/slide -> no positional shift).
  host: {
    '[class]': 'toastClasses()',
    '[style.display]': 'displayStyle()',
    '(mouseenter)': 'stickAround()',
    '(mouseleave)': 'delayedHideToast()',
    '(click)': 'tapToast()',
    'animate.enter': 'toast-in',
    '[style.--animation-easing]': 'params.easing',
    '[style.--animation-duration]': "params.easeTime + 'ms'",
  },
  templateUrl: './ui-toast.component.html',
  styleUrl: './ui-toast.component.scss',
})
export class UiToastComponent extends Toast {
  /** ngx-toastr toast type (`toast-success` | `toast-error` | `toast-warning` | `toast-info`) → ui-alert variant. */
  get alertType(): UiAlertType {
    switch (this.toastPackage.toastType) {
      case 'toast-success':
        return 'success';
      case 'toast-error':
        return 'danger';
      case 'toast-warning':
        return 'warning';
      default:
        return 'info';
    }
  }
}
