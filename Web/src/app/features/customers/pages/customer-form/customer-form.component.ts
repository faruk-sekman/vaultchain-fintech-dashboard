/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  ViewChild,
  computed,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { AbstractControl, FormArray, FormGroup, Validators } from '@angular/forms';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { EMPTY, Subject } from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  exhaustMap,
  filter,
  finalize,
  map,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs/operators';

import { CustomersApi } from '@core/api/customers.api';
import { AuthService } from '@core/auth/auth.service';
import { ToastService } from '@core/services/toast.service';
import { AppErrorService, extractApiError } from '@core/services/app-error.service';

import { UiFormComponent } from '@shared/components/ui-form/ui-form.component';
import { UiButtonComponent } from '@shared/components/ui-button/ui-button.component';
import { UiSkeletonComponent } from '@shared/components/ui-skeleton/ui-skeleton.component';
import { UiCardComponent } from '@shared/components/ui-card/ui-card.component';
import { UiAvatarComponent } from '@shared/components/ui-avatar/ui-avatar.component';
import { UiBadgeComponent } from '@shared/components/ui-badge/ui-badge.component';
import {
  UiBreadcrumbComponent,
  UiBreadcrumbItem,
} from '@shared/components/ui-breadcrumb/ui-breadcrumb.component';
import { CustomerStatusBadgeComponent } from '@features/customers/components/customer-status-badge/customer-status-badge.component';
import { FieldConfig, FormSection } from '@shared/components/ui-form/ui-form.types';
import {
  CreateCustomerRequest,
  Customer,
  KycStatus,
  UpdateCustomerRequest,
} from '@shared/models/customer.model';
import { KYC_STATUS_OPTIONS } from '@shared/utils/kyc-status';
import {
  alphaTextValidator,
  dateOfBirthValidator,
  digitsLengthValidator,
  fullNameValidator,
  noMultipleSpacesValidator,
  phoneNumberValidator,
  postalCodeValidator,
  safeTextValidator,
  strictEmailValidator,
  trimmedRequiredValidator,
  turkishNationalIdValidator,
} from '@shared/validators/custom.validators';

@Component({
  selector: 'app-customer-form',
  standalone: true,
  imports: [
    CommonModule,
    TranslateModule,
    UiFormComponent,
    UiButtonComponent,
    UiSkeletonComponent,
    UiCardComponent,
    UiAvatarComponent,
    UiBadgeComponent,
    UiBreadcrumbComponent,
    CustomerStatusBadgeComponent,
  ],
  templateUrl: './customer-form.component.html',
  styleUrl: './customer-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CustomerFormComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild(UiFormComponent) uiForm?: UiFormComponent;
  private readonly destroy$ = new Subject<void>();
  private readonly submit$ = new Subject<{ value: any; form: UiFormComponent }>();

  readonly mode = signal<'create' | 'edit'>('create');
  id: string | null = null;

  readonly loading = signal(false);
  readonly initialValue = signal<any>(null);
  readonly fields = signal<FieldConfig[]>([]);
  // The loaded customer (edit mode only) feeding the v2 §5 avatar identity block. Presentational:
  // name/email/phone arrive MASKED upstream, and nothing here is ever written back to the form.
  readonly loadedCustomer = signal<Customer | null>(null);
  // Visual grouping of the SAME field objects into design §7.5 sections. Derived from `fields()`, so
  // it follows the create/edit field set automatically; the flat `fields` signal is kept intact for
  // the form's submit/validation wiring and the existing specs.
  readonly sections = computed<FormSection[]>(() => this.toSections(this.fields()));

  constructor(
    private readonly route: ActivatedRoute,
    private readonly router: Router,
    private readonly api: CustomersApi,
    private readonly toast: ToastService,
    private readonly appError: AppErrorService,
    private readonly i18n: TranslateService,
    // Nullable default keeps lean `new Component(...)` test setups valid; the app always injects it.
    private readonly auth: AuthService | null = null,
  ) {}

  ngOnInit(): void {
    this.route.paramMap
      .pipe(
        map(params => params.get('id')),
        distinctUntilChanged(),
        tap(id => {
          this.id = id;
          this.mode.set(this.modeFromId(id));
          this.loading.set(!!id);
          this.initialValue.set(this.initialValueFromId(id));
          this.loadedCustomer.set(null);
          this.fields.set(this.buildFields(this.mode()));
        }),
        filter((id): id is string => !!id),
        switchMap(id => {
          // A12: edit is Administrator-only and loads UNMASKED via ?reveal=true (server-audited).
          // Without the reveal permission (defense-in-depth) the legacy masked-placeholder path
          // stays as the fallback so the form still works, blank-means-keep semantics intact.
          const reveal = !!this.auth?.hasPermission('customers.pii.reveal');
          return this.api.getById(id, { reveal }).pipe(
            tap(c => {
              this.initialValue.set(this.toFormValue(c, reveal));
              this.loadedCustomer.set(c);
              if (reveal) {
                // Real values are in the controls → the fields validate like create (required),
                // no keep-blank hints, no masked placeholders. Field NAMES are unchanged, so the
                // ui-form FormGroup survives and only validators re-sync.
                this.fields.set(this.buildFields('edit', true));
              } else {
                this.applyMaskedPlaceholders(c);
              }
            }),
            catchError(err => {
              this.appError.handleError(err, {
                source: 'CustomerFormComponent',
                operation: 'loadCustomer',
              });
              this.loading.set(false);
              return EMPTY;
            }),
            finalize(() => {
              this.loading.set(false);
            }),
          );
        }),
        takeUntil(this.destroy$),
      )
      .subscribe();

    this.submit$
      .pipe(
        exhaustMap(({ value, form }) => {
          this.loading.set(true);
          const req$ = this.saveRequest(value);

          return req$.pipe(
            tap(c => {
              this.toast.success(this.successMessage());
              this.router.navigate(['/customers', c.id]);
            }),
            catchError(err => {
              this.bindServerValidationErrors(err, form);
              this.appError.handleError(err, {
                source: 'CustomerFormComponent',
                operation: 'saveCustomer',
              });
              return EMPTY;
            }),
            finalize(() => {
              this.loading.set(false);
            }),
          );
        }),
        takeUntil(this.destroy$),
      )
      .subscribe();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  ngAfterViewInit(): void {
    const form = this.uiForm?.form;
    if (!form) return;
    form.setValidators([...(this.uiForm?.formValidators ?? [])]);
    form.updateValueAndValidity({ emitEvent: false });
  }

  back() {
    if (this.mode() === 'edit' && this.id) {
      this.router.navigate(['/customers', this.id]);
      return;
    }
    this.router.navigate(['/customers']);
  }

  /**
   * Breadcrumb trail: Customers › (the customer, in edit mode) › Create|Edit. The current page
   * (last crumb) is the create/edit action; in edit mode an intermediate crumb links back to the
   * customer's detail. Labels are i18n keys resolved by the breadcrumb component.
   */
  get breadcrumbItems(): UiBreadcrumbItem[] {
    const items: UiBreadcrumbItem[] = [{ labelKey: 'customers.title', link: '/customers' }];
    if (this.mode() === 'edit' && this.id) {
      items.push({ labelKey: 'common.details', link: ['/customers', this.id] });
      items.push({ labelKey: 'customers.edit' });
    } else {
      items.push({ labelKey: 'customers.create' });
    }
    return items;
  }

  onSubmit(value: any, form: UiFormComponent) {
    this.submit$.next({ value, form });
  }

  /**
   * Bind server-side validation errors to the offending form controls, reading the REAL envelope
   * path `err.error.error.details` (a `string[]`) — not the legacy `err.error.errors` map, which the
   * backend never sends. Each detail is parsed for a leading field token; matched details attach to
   * their control as an `api` error, and any unmatched ones fall back to a control-less form error so
   * the operator still sees the specific reason (e.g. "national_id already exists").
   */
  private bindServerValidationErrors(err: unknown, form?: UiFormComponent): void {
    const group = form?.form;
    if (!group) return;
    const details = this.extractDetails(err);
    if (!details.length) return;

    const unmatched: string[] = [];
    for (const detail of details) {
      const path = this.controlPathForDetail(detail);
      const ctrl = path ? group.get(path) : null;
      if (ctrl) {
        ctrl.setErrors({ ...(ctrl.errors ?? {}), api: detail });
        ctrl.markAsTouched();
        // The shared ui-form gates per-control error display on `dirty`; in EDIT mode a server error
        // on a control the operator never personally edited would otherwise stay invisible.
        ctrl.markAsDirty();
      } else {
        unmatched.push(detail);
      }
    }

    // Details that don't map to a specific control (e.g. cross-field rules) still carry the actionable
    // reason — surface them as a toast so the operator sees the cause, since the shared ui-form renders
    // per-control errors only and has no form-level error slot.
    if (unmatched.length) {
      this.toast.error(unmatched.join(' '));
    }
  }

  /** Pull the validation `details` string array out of the backend error envelope, untrusted. */
  private extractDetails(err: unknown): string[] {
    const body =
      err && typeof err === 'object' && 'error' in err ? (err as { error: unknown }).error : err;
    const envelope = extractApiError(body);
    const raw = envelope?.details;
    if (!Array.isArray(raw)) return [];
    return raw.filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
  }

  /**
   * Best-effort map of a server detail string to a form control path. Validation details lead with
   * the field name (e.g. "email must be a valid email", "national_id already exists"); we normalise
   * that leading token to one of the known control paths. Returns null when no field can be inferred.
   */
  private controlPathForDetail(detail: string): string | null {
    const token = detail
      .trim()
      .split(/[\s:.]+/)[0]
      ?.toLowerCase();
    if (!token) return null;
    return this.fieldPathMap[token] ?? null;
  }

  // snake_case / synonym → reactive-form control path. Address subfields are nested under `address`.
  private readonly fieldPathMap: Record<string, string> = {
    name: 'name',
    // The FE sends `fullName: payload.name`, so backend validation details lead with `fullName`
    // (e.g. "fullName must be longer than or equal to 3 characters"). Map that token (and the
    // snake_case variant) back to the `name` control so the reason binds inline, not as a raw toast.
    fullname: 'name',
    full_name: 'name',
    email: 'email',
    phone: 'phone',
    dateofbirth: 'dateOfBirth',
    date_of_birth: 'dateOfBirth',
    nationalid: 'nationalId',
    national_id: 'nationalId',
    kycstatus: 'kycStatus',
    kyc_status: 'kycStatus',
    country: 'address.country',
    city: 'address.city',
    postalcode: 'address.postalCode',
    postal_code: 'address.postalCode',
    line1: 'address.line1',
    address: 'address',
  };

  handleSubmit() {
    if (this.mode() === 'create') {
      this.markAllDirty(this.uiForm?.form ?? null);
    }
    this.uiForm?.submit();
  }

  clearForm() {
    if (!this.uiForm) return;
    if (this.mode() === 'edit') {
      this.uiForm.resetTo(this.editResetValue());
      return;
    }
    this.uiForm.resetTo({});
  }

  private toFormValue(c: Customer, revealed = false) {
    return {
      // A12 reveal path: the admin edit loads REAL values, so the controls carry them and the
      // loaded record is the valid baseline. Masked fallback: name/email/phone stay blank
      // ("leave blank to keep current") — a masked value must never be re-submitted.
      name: revealed ? c.name : '',
      email: revealed ? c.email : '',
      phone: revealed ? c.phone : '',
      walletNumber: c.walletNumber,
      dateOfBirth: c.dateOfBirth,
      nationalId: c.nationalId,
      address: c.address,
      kycStatus: c.kycStatus,
      isActive: c.isActive,
      // Carried (not shown) so the update can send it back for optimistic-concurrency.
      rowVersion: c.rowVersion,
    };
  }

  /**
   * Edit mode only: show the MASKED current value (name/email/phone arrive masked upstream)
   * as a non-editable placeholder so the field no longer looks empty, while the control VALUE stays
   * blank (blank-means-keep is preserved — a masked value is never written back). Only the
   * `placeholder` is set; field NAMES are untouched, so `app-ui-form`'s control signature is stable
   * and the FormGroup is NOT rebuilt (values/validation state survive). A masked value that comes back
   * empty sets no placeholder. The `fields` signal is re-emitted with a fresh array so the derived
   * `sections()` recomputes and the OnPush form picks up the new placeholder.
   */
  private applyMaskedPlaceholders(c: Customer): void {
    const masked: Record<string, string | undefined> = {
      name: c.name,
      email: c.email,
      phone: c.phone,
    };
    const next = this.fields().map(field => {
      const value = masked[field.name];
      if (value && value.trim().length > 0) {
        return { ...field, placeholder: value };
      }
      return field;
    });
    this.fields.set(next);
  }

  private toPayloadBase(v: any) {
    const norm = (val: any) => this.normalizeValue(val);
    const emptyToUndefined = (val: any) => {
      if (typeof val !== 'string') return val;
      const t = val.trim();
      if (t.length) return t;
      return undefined;
    };
    return {
      name: norm(v.name),
      email: norm(v.email),
      phone: norm(v.phone),
      dateOfBirth: norm(v.dateOfBirth),
      nationalId: norm(v.nationalId) ?? '',
      address: {
        country: norm(v.address?.country),
        city: norm(v.address?.city),
        postalCode: norm(v.address?.postalCode),
        line1: norm(v.address?.line1),
      },
      kycStatus: emptyToUndefined(v.kycStatus),
      isActive: !!v.isActive,
    };
  }

  private toCreatePayload(v: any): CreateCustomerRequest {
    const base = this.toPayloadBase(v);
    const { kycStatus, isActive, ...rest } = base;
    return rest;
  }

  private toUpdatePayload(v: any): UpdateCustomerRequest {
    const base = this.toPayloadBase(v);
    const initial = this.initialValue();
    // name/email/phone are MASKED on read, so send each only when the operator changed it — an
    // unchanged (still-masked) value must never be sent back (the backend preserves the real one).
    const nameChanged = base.name !== initial?.name;
    const emailChanged = base.email !== initial?.email;
    const phoneChanged = base.phone !== initial?.phone;
    // Likewise the lossy KYC / active controls, so a no-op save never collapses the backend's
    // richer status (e.g. REJECTED → PENDING).
    const kycChanged = base.kycStatus !== undefined && base.kycStatus !== initial?.kycStatus;
    const isActiveChanged = base.isActive !== initial?.isActive;
    return {
      name: nameChanged ? base.name : undefined,
      email: emailChanged ? base.email : undefined,
      phone: phoneChanged ? base.phone : undefined,
      dateOfBirth: base.dateOfBirth,
      // National ID is read-only on edit; preserve the loaded value as a STRING (never round-trip a TC
      // Kimlik No through JS Number — re-audit fn-nationalid-number-cast). The backend ignores it anyway.
      nationalId: String(initial?.nationalId ?? v.nationalId ?? ''),
      address: base.address,
      kycStatus: kycChanged ? (base.kycStatus as KycStatus) : undefined,
      isActive: isActiveChanged ? base.isActive : undefined,
      // Optimistic-concurrency token from the loaded detail; mismatch → 409.
      rowVersion: Number(initial?.rowVersion ?? 0),
    };
  }

  private buildFields(mode: 'create' | 'edit', revealed = false): FieldConfig[] {
    // Masked edit keeps name/email/phone optional (blank-means-keep). The A12 REVEALED edit loads
    // real values, so they validate exactly like create: required, no keep-blank hint.
    const requiredOnCreate =
      mode === 'create' || revealed ? [Validators.required, trimmedRequiredValidator()] : [];
    const keepHint: Pick<FieldConfig, 'hintKey'> =
      mode === 'edit' && !revealed ? { hintKey: 'customers.keepCurrentHint' } : {};
    const base: FieldConfig[] = [
      {
        name: 'name',
        labelKey: 'customers.name',
        type: 'text',
        ...keepHint,
        validators: [
          ...requiredOnCreate,
          noMultipleSpacesValidator(),
          fullNameValidator(),
          safeTextValidator(),
          Validators.minLength(3),
          Validators.maxLength(100),
        ],
      },
      {
        name: 'email',
        labelKey: 'customers.email',
        type: 'email',
        ...keepHint,
        validators: [...requiredOnCreate, strictEmailValidator()],
      },
      {
        name: 'phone',
        labelKey: 'customers.phone',
        type: 'text',
        ...keepHint,
        // B7: letters/spaces never enter the model — only digits and a leading '+' (matches the
        // FE phoneNumberValidator and the BE DTO pattern, keeping both sides on one alphabet).
        stripPattern: '[^0-9+]',
        // QA minor: cap typing at 16 chars (15 digits + an optional leading '+') so the field can't run
        // past the validator's 15-digit ceiling as the user types; the validator still enforces 7–15.
        maxLength: 16,
        validators: [
          ...requiredOnCreate,
          noMultipleSpacesValidator(),
          digitsLengthValidator({ min: 7, max: 15 }),
          phoneNumberValidator(),
        ],
      },
      ...this.walletNumberField(mode),
      {
        name: 'dateOfBirth',
        labelKey: 'customers.dateOfBirth',
        type: 'date',
        validators: [Validators.required, dateOfBirthValidator({ minAge: 18, maxAge: 120 })],
      },
      {
        name: 'nationalId',
        labelKey: 'customers.nationalId',
        type: 'text',
        // National ID is an immutable identity field: editable only on create.
        disabled: mode === 'edit',
        readOnly: mode === 'edit',
        validators: [
          Validators.required,
          trimmedRequiredValidator(),
          noMultipleSpacesValidator(),
          turkishNationalIdValidator(),
        ],
      },
      {
        name: 'address.country',
        labelKey: 'customers.address.country',
        type: 'text',
        validators: [
          Validators.required,
          trimmedRequiredValidator(),
          noMultipleSpacesValidator(),
          safeTextValidator(),
          alphaTextValidator(),
          Validators.maxLength(50),
        ],
      },
      {
        name: 'address.city',
        labelKey: 'customers.address.city',
        type: 'text',
        validators: [
          Validators.required,
          trimmedRequiredValidator(),
          noMultipleSpacesValidator(),
          safeTextValidator(),
          alphaTextValidator(),
          Validators.maxLength(80),
        ],
      },
      {
        name: 'address.postalCode',
        labelKey: 'customers.address.postalCode',
        type: 'text',
        // QA #3: strip non-digits as typed so letters ("ABCDE") never enter the model, and validate the
        // numeric shape (4–10 digits) as a backstop so an all-letters value can't be saved.
        stripPattern: '[^0-9]',
        validators: [
          trimmedRequiredValidator(),
          noMultipleSpacesValidator(),
          Validators.required,
          postalCodeValidator(),
          Validators.maxLength(12),
        ],
      },
      {
        name: 'address.line1',
        labelKey: 'customers.address.line1',
        type: 'text',
        validators: [
          Validators.required,
          trimmedRequiredValidator(),
          noMultipleSpacesValidator(),
          safeTextValidator(),
          Validators.maxLength(120),
          Validators.minLength(6),
        ],
      },
    ];

    if (mode === 'edit') {
      base.push(
        {
          name: 'kycStatus',
          labelKey: 'customers.kycStatus',
          type: 'select',
          // Edit form sets a real KYC value — use the plain options (no blank "All" filter entry),
          // so the control can never present an empty selection.
          options: KYC_STATUS_OPTIONS,
        },
        {
          name: 'isActive',
          labelKey: 'customers.active',
          type: 'checkbox',
          hintKey: 'customers.active',
        },
      );
    }

    return base;
  }

  /**
   * Group the already-built fields into the design §7.5 sections (Identity / Address / Wallet-Finance
   * / KYC-Status) for the grouped `app-ui-form` layout. This is purely visual: the same FieldConfig
   * objects are reused (validators, names, masking untouched) and only `address.line1` is marked
   * full-width. Empty sections (e.g. Wallet/KYC in create mode) are dropped so no bare header shows.
   *
   * A trailing catch-all section guarantees any field not assigned above still renders and submits —
   * so adding a field to `buildFields` later can never silently remove its control from the form.
   */
  private toSections(fields: ReadonlyArray<FieldConfig>): FormSection[] {
    const byName = new Map(fields.map(f => [f.name, f]));
    const used = new Set<string>();
    const take = (name: string, overrides?: Partial<FieldConfig>): FieldConfig[] => {
      const found = byName.get(name);
      if (!found) return [];
      used.add(name);
      return [overrides ? { ...found, ...overrides } : found];
    };

    const sections: FormSection[] = [
      {
        icon: 'ri-user-line',
        titleKey: 'customers.sections.identity.title',
        descriptionKey: 'customers.sections.identity.description',
        fields: [
          ...take('name'),
          ...take('email'),
          ...take('phone'),
          ...take('dateOfBirth'),
          // Identity carries 5 fields; in the 2-col grid the trailing National ID would otherwise
          // strand alone on a half-row. Span it full-width (like address.line1) so the row reads
          // intentional rather than orphaned. Purely presentational — the control is unchanged.
          ...take('nationalId', { fullWidth: true }),
        ],
      },
      {
        icon: 'ri-map-pin-line',
        titleKey: 'customers.sections.address.title',
        descriptionKey: 'customers.sections.address.description',
        fields: [
          ...take('address.country'),
          ...take('address.city'),
          ...take('address.postalCode'),
          ...take('address.line1', { fullWidth: true }),
        ],
      },
      {
        icon: 'ri-wallet-3-line',
        titleKey: 'customers.sections.walletFinance.title',
        descriptionKey: 'customers.sections.walletFinance.description',
        fields: [...take('walletNumber')],
      },
      {
        icon: 'ri-shield-check-line',
        titleKey: 'customers.sections.kycStatus.title',
        descriptionKey: 'customers.sections.kycStatus.description',
        fields: [...take('kycStatus'), ...take('isActive')],
      },
    ];

    const leftovers = fields.filter(f => !used.has(f.name));
    if (leftovers.length) sections.push({ fields: leftovers });

    return sections.filter(section => section.fields.length > 0);
  }

  private modeFromId(id: string | null): 'create' | 'edit' {
    if (id) return 'edit';
    return 'create';
  }

  private initialValueFromId(id: string | null): any {
    if (id) return null;
    return { isActive: true };
  }

  private saveRequest(value: any) {
    if (this.mode() === 'create') return this.api.create(this.toCreatePayload(value));
    return this.api.update(this.id!, this.toUpdatePayload(value));
  }

  private successMessage(): string {
    if (this.mode() === 'create') return this.i18n.instant('customers.created');
    return this.i18n.instant('customers.updated');
  }

  private editResetValue(): any {
    const value = this.initialValue();
    if (!value) return null;
    return JSON.parse(JSON.stringify(value));
  }

  private normalizeValue(val: any): any {
    if (typeof val === 'string') return val.trim();
    return val;
  }

  private walletNumberField(mode: 'create' | 'edit'): FieldConfig[] {
    if (mode !== 'edit') return [];
    return [
      {
        name: 'walletNumber',
        labelKey: 'customers.walletNumber',
        type: 'text',
        disabled: true,
        readOnly: true,
      },
    ];
  }

  private markAllDirty(control: AbstractControl | null) {
    if (!control) return;
    if (control instanceof FormGroup) {
      Object.values(control.controls).forEach(child => this.markAllDirty(child));
      control.markAsDirty();
      return;
    }
    if (control instanceof FormArray) {
      control.controls.forEach(child => this.markAllDirty(child));
      control.markAsDirty();
      return;
    }
    control.markAsDirty();
  }
}
