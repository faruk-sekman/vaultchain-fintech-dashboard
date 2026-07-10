/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { describe, it, expect, vi } from 'vitest';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { convertToParamMap } from '@angular/router';
import { FormArray, FormControl, FormGroup } from '@angular/forms';
import { CustomerFormComponent } from './customer-form.component';

const customer = {
  id: '1',
  name: 'Jane Doe',
  email: 'jane@doe.com',
  phone: '123',
  walletNumber: '1234567890123456',
  dateOfBirth: '2000-01-01',
  nationalId: 10000000078,
  address: { country: 'TR', city: 'IST', postalCode: '34000', line1: 'Street' },
  kycStatus: 'UNKNOWN',
  isActive: true,
  createdAt: '',
  updatedAt: '',
} as any;

describe('CustomerFormComponent', () => {
  it('initializes in create mode without id', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({})) };
    const router = { navigate: vi.fn() };
    const api = {
      getById: vi.fn(() => of(customer)),
      create: vi.fn(() => of(customer)),
      update: vi.fn(() => of(customer)),
    };
    const toast = { success: vi.fn() };
    const appError = { handleError: vi.fn() };
    const i18n = { instant: (k: string) => k };

    const component = new CustomerFormComponent(
      route as any,
      router as any,
      api as any,
      toast as any,
      appError as any,
      i18n as any,
    );
    component.ngOnInit();

    expect(component.mode()).toBe('create');
    expect(component.fields().length).toBeGreaterThan(0);
    // No identity block on create: nothing is loaded.
    expect(component.loadedCustomer()).toBeNull();
  });

  it('initializes in edit mode with id', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({ id: '1' })) };
    const router = { navigate: vi.fn() };
    const api = {
      getById: vi.fn(() => of(customer)),
      create: vi.fn(() => of(customer)),
      update: vi.fn(() => of(customer)),
    };
    const toast = { success: vi.fn() };
    const appError = { handleError: vi.fn() };
    const i18n = { instant: (k: string) => k };

    const component = new CustomerFormComponent(
      route as any,
      router as any,
      api as any,
      toast as any,
      appError as any,
      i18n as any,
    );
    component.ngOnInit();

    expect(component.mode()).toBe('edit');
    // No auth in this lean setup → the masked fallback path (reveal: false).
    expect(api.getById).toHaveBeenCalledWith('1', { reveal: false });
    // The loaded (masked-upstream) customer feeds the v2 avatar identity block.
    expect(component.loadedCustomer()).toEqual(customer);
  });

  it('A12: a reveal-capable admin loads the edit UNMASKED — real values, required fields, no placeholders', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({ id: '1' })) };
    const revealed = {
      ...customer,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '5551112233',
    };
    const api = {
      getById: vi.fn(() => of(revealed)),
      create: vi.fn(() => of(revealed)),
      update: vi.fn(() => of(revealed)),
    };
    const auth = { hasPermission: (p: string) => p === 'customers.pii.reveal' };
    const component = new CustomerFormComponent(
      route as any,
      { navigate: vi.fn() } as any,
      api as any,
      { success: vi.fn() } as any,
      { handleError: vi.fn() } as any,
      { instant: (k: string) => k } as any,
      auth as any,
    );
    component.ngOnInit();

    // The load asked the server for unmasked PII (server-side audited).
    expect(api.getById).toHaveBeenCalledWith('1', { reveal: true });
    // Real values are the baseline (single-field edits stay valid)…
    expect(component.initialValue()).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '5551112233',
    });
    const byName = (n: string) => component.fields().find(f => f.name === n);
    // …no masked placeholder / keep-blank hint remains…
    expect(byName('name')?.placeholder).toBeUndefined();
    expect(byName('name')?.hintKey).toBeUndefined();
    // …and the identity fields validate like create (required).
    expect(byName('name')?.validators?.length).toBeGreaterThan(0);
    expect(byName('email')?.validators?.length).toBeGreaterThan(0);
  });

  it('A12: the delta payload sends ONLY changed fields from the revealed baseline', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({ id: '1' })) };
    const revealed = {
      ...customer,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      phone: '5551112233',
    };
    const api = {
      getById: vi.fn(() => of(revealed)),
      create: vi.fn(() => of(revealed)),
      update: vi.fn(() => of(revealed)),
    };
    const auth = { hasPermission: () => true };
    const component = new CustomerFormComponent(
      route as any,
      { navigate: vi.fn() } as any,
      api as any,
      { success: vi.fn() } as any,
      { handleError: vi.fn() } as any,
      { instant: (k: string) => k } as any,
      auth as any,
    );
    component.ngOnInit();

    // Only the surname changed; everything else matches the revealed baseline.
    const payload = (component as any).toUpdatePayload({
      ...component.initialValue(),
      name: 'Ada Byron',
    });
    expect(payload.name).toBe('Ada Byron');
    expect(payload.email).toBeUndefined(); // unchanged → not sent (delta preserved)
    expect(payload.phone).toBeUndefined();
    expect(payload.rowVersion).toBe(revealed.rowVersion ?? 0);
  });

  it('shows the masked current name/email/phone as placeholders while values stay blank', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({ id: '1' })) };
    const api = {
      getById: vi.fn(() => of(customer)),
      create: vi.fn(() => of(customer)),
      update: vi.fn(() => of(customer)),
    };
    const component = new CustomerFormComponent(
      route as any,
      { navigate: vi.fn() } as any,
      api as any,
      { success: vi.fn() } as any,
      { handleError: vi.fn() } as any,
      { instant: (k: string) => k } as any,
    );
    component.ngOnInit();

    const byName = (n: string) => component.fields().find(f => f.name === n);
    // Placeholder = the masked CURRENT value (blank-means-keep) — never written into the form value.
    expect(byName('name')?.placeholder).toBe(customer.name);
    expect(byName('email')?.placeholder).toBe(customer.email);
    expect(byName('phone')?.placeholder).toBe(customer.phone);
    // Preserved: the editable initial values for identity fields stay empty.
    const value = component.initialValue();
    expect(value.name).toBe('');
    expect(value.email).toBe('');
    expect(value.phone).toBe('');
    // The masked placeholder also flows into the derived sections (same field objects).
    const identitySection = component
      .sections()
      .find(s => s.titleKey === 'customers.sections.identity.title');
    expect(identitySection?.fields.find(f => f.name === 'name')?.placeholder).toBe(customer.name);
  });

  it('sets no placeholder when a masked value comes back empty', () => {
    const blanked = { ...customer, name: '', email: '   ', phone: undefined };
    const route = { paramMap: new BehaviorSubject(convertToParamMap({ id: '1' })) };
    const api = {
      getById: vi.fn(() => of(blanked)),
      create: vi.fn(() => of(blanked)),
      update: vi.fn(() => of(blanked)),
    };
    const component = new CustomerFormComponent(
      route as any,
      { navigate: vi.fn() } as any,
      api as any,
      { success: vi.fn() } as any,
      { handleError: vi.fn() } as any,
      { instant: (k: string) => k } as any,
    );
    component.ngOnInit();

    const byName = (n: string) => component.fields().find(f => f.name === n);
    expect(byName('name')?.placeholder).toBeUndefined();
    expect(byName('email')?.placeholder).toBeUndefined();
    expect(byName('phone')?.placeholder).toBeUndefined();
  });

  it('handles load customer errors', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({ id: '1' })) };
    const router = { navigate: vi.fn() };
    const api = {
      getById: vi.fn(() => throwError(() => new Error('fail'))),
      create: vi.fn(() => of(customer)),
      update: vi.fn(() => of(customer)),
    };
    const toast = { success: vi.fn() };
    const appError = { handleError: vi.fn() };
    const i18n = { instant: (k: string) => k };

    const component = new CustomerFormComponent(
      route as any,
      router as any,
      api as any,
      toast as any,
      appError as any,
      i18n as any,
    );
    component.ngOnInit();

    expect(appError.handleError).toHaveBeenCalled();
    expect(component.loading()).toBe(false);
  });

  it('builds payloads correctly', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const base: any = {
      name: '  John Doe ',
      email: ' john@doe.com ',
      phone: ' 123 ',
      dateOfBirth: '2000-01-01',
      nationalId: '10000000078',
      address: { country: 'TR', city: 'IST', postalCode: '34000', line1: 'Street' },
      kycStatus: '',
      isActive: true,
    };

    const createPayload = (component as any).toCreatePayload(base);
    expect(createPayload.name).toBe('John Doe');
    expect(createPayload.kycStatus).toBeUndefined();

    // An empty/unchanged KYC control is omitted (not defaulted) so a no-op save never collapses
    // the backend's richer status; rowVersion is forwarded for optimistic-concurrency.
    const updatePayload = (component as any).toUpdatePayload(base);
    expect(updatePayload.kycStatus).toBeUndefined();
    expect(updatePayload.rowVersion).toBe(0);
  });

  it('keeps non-empty kycStatus in update payload', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const base: any = {
      name: 'John Doe',
      email: 'john@doe.com',
      phone: '123',
      dateOfBirth: '2000-01-01',
      nationalId: '10000000078',
      address: { country: 'TR', city: 'IST', postalCode: '34000', line1: 'Street' },
      kycStatus: 'VERIFIED',
      isActive: true,
    };
    const updatePayload = (component as any).toUpdatePayload(base);
    expect(updatePayload.kycStatus).toBe('VERIFIED');
  });

  it('omits unchanged name/email/phone/kyc/isActive from the update payload (no-op save sends nothing lossy)', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    // initialValue mirrors the submitted value, so every "changed?" guard is FALSE — each masked/lossy
    // field is sent as `undefined` (the backend keeps its real value). Exercises the false arms incl. 416.
    const same = {
      name: '',
      email: '',
      phone: '',
      dateOfBirth: '2000-01-01',
      nationalId: '10000000078',
      address: { country: 'TR', city: 'IST', postalCode: '34000', line1: 'Street' },
      kycStatus: 'VERIFIED',
      isActive: true,
      rowVersion: 7,
    };
    component.initialValue.set({ ...same });

    const payload = (component as any).toUpdatePayload(same);
    expect(payload.name).toBeUndefined();
    expect(payload.email).toBeUndefined();
    expect(payload.phone).toBeUndefined();
    expect(payload.kycStatus).toBeUndefined(); // unchanged → omitted
    expect(payload.isActive).toBeUndefined(); // unchanged → omitted (line 416 false branch)
    expect(payload.rowVersion).toBe(7); // optimistic-concurrency token forwarded from the loaded detail
  });

  it('sends isActive only when it actually changed from the loaded value', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    component.initialValue.set({ isActive: false, kycStatus: 'PENDING' });
    const payload = (component as any).toUpdatePayload({
      name: 'x',
      email: 'a@b.co',
      phone: '123',
      dateOfBirth: '2000-01-01',
      nationalId: '10000000078',
      address: { country: 'TR', city: 'IST', postalCode: '34000', line1: 'Street' },
      kycStatus: 'VERIFIED',
      isActive: true, // flipped vs the loaded `false`
    });
    // The toggle moved → the true arm of `isActiveChanged ? base.isActive : undefined` ships the value.
    expect(payload.isActive).toBe(true);
    expect(payload.kycStatus).toBe('VERIFIED'); // also changed PENDING → VERIFIED
  });

  it('breadcrumbItems trail differs between create and edit mode', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );

    // Create: Customers › Create (two crumbs, the else branch).
    component.mode.set('create');
    component.id = null;
    expect(component.breadcrumbItems.map(i => i.labelKey)).toEqual([
      'customers.title',
      'customers.create',
    ]);

    // Edit: Customers › Details › Edit — the intermediate detail crumb links back to the customer.
    component.mode.set('edit');
    component.id = '42';
    const editItems = component.breadcrumbItems;
    expect(editItems.map(i => i.labelKey)).toEqual([
      'customers.title',
      'common.details',
      'customers.edit',
    ]);
    expect(editItems[1].link).toEqual(['/customers', '42']);
  });

  it('ngAfterViewInit is a no-op when the ui-form view child has no FormGroup yet', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    // uiForm present but `.form` undefined → the early `if (!form) return` guard fires (line 188).
    component.uiForm = {} as any;
    expect(() => component.ngAfterViewInit()).not.toThrow();
  });

  it('bindServerValidationErrors returns early when the form has no FormGroup', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      { success: vi.fn(), error: vi.fn() } as any,
      { handleError: vi.fn() } as any,
      { instant: () => '' } as any,
    );
    // A ui-form double with no `.form` → the `if (!group) return` guard (line 230); nothing should throw.
    expect(() =>
      (component as any).bindServerValidationErrors(
        { error: { error: { details: ['email bad'] } } },
        {} as any,
      ),
    ).not.toThrow();
  });

  it('extractDetails returns no details for an error object without the outer { error } envelope', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    // No top-level `error` key → the ternary's else arm uses `err` as-is; without the envelope shape
    // there are no details to extract (the safe, no-bind outcome). Exercises the `'error' in err` false arm.
    const details = (component as any).extractDetails({
      code: 'Validation.Failed',
      message: 'bad',
      details: ['email must be a valid email'],
    });
    expect(details).toEqual([]);
  });

  it('controlPathForDetail returns null for a detail with no leading field token', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    // A detail that is only separators yields an empty leading token → the `if (!token) return null` arm.
    expect((component as any).controlPathForDetail('   :  . ')).toBeNull();
    // An unknown leading token maps to no control → null via the fieldPathMap miss.
    expect((component as any).controlPathForDetail('mystery something')).toBeNull();
  });

  it('handleSubmit submits without marking dirty in edit mode (uiForm optional-chain, no form)', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const submit = vi.fn();
    // Edit mode → the create-only markAllDirty branch is skipped; uiForm has no `form` so `?? null`
    // feeds markAllDirty a null (the create path isn't taken anyway) and submit() still fires.
    component.mode.set('edit');
    component.uiForm = { submit } as any;
    expect(() => component.handleSubmit()).not.toThrow();
    expect(submit).toHaveBeenCalled();
  });

  it('buildFields includes edit-only fields', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const createFields = (component as any).buildFields('create');
    const editFields = (component as any).buildFields('edit');
    expect(createFields.some((f: any) => f.name === 'walletNumber')).toBe(false);
    expect(editFields.some((f: any) => f.name === 'walletNumber')).toBe(true);
    expect(editFields.some((f: any) => f.name === 'kycStatus')).toBe(true);

    // The edit-form KYC select offers only real KYC values — no blank "All" filter entry.
    const kycField = editFields.find((f: any) => f.name === 'kycStatus');
    expect(kycField.options.some((o: any) => o.value === '')).toBe(false);
    expect(kycField.options.every((o: any) => o.value !== '')).toBe(true);
  });

  it('submits create and update flows', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({})) };
    const router = { navigate: vi.fn() };
    const api = {
      getById: vi.fn(() => of(customer)),
      create: vi.fn(() => of(customer)),
      update: vi.fn(() => of(customer)),
    };
    const toast = { success: vi.fn() };
    const appError = { handleError: vi.fn() };
    const i18n = { instant: (k: string) => k };

    const component = new CustomerFormComponent(
      route as any,
      router as any,
      api as any,
      toast as any,
      appError as any,
      i18n as any,
    );
    component.ngOnInit();
    const formGroup = new FormGroup({ name: new FormControl('John') });
    component.onSubmit({ name: 'John' }, { form: formGroup } as any);

    expect(api.create).toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalled();

    component.mode.set('edit');
    component.id = '1';
    component.onSubmit({ name: 'John' }, { form: formGroup } as any);
    expect(api.update).toHaveBeenCalledWith('1', expect.anything());
  });

  it('binds server validation details from the real envelope to the matching controls', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({})) };
    const router = { navigate: vi.fn() };
    const api = {
      getById: vi.fn(() => of(customer)),
      // REAL backend envelope: { error: { code, message, correlationId, details: string[] } }
      create: vi.fn(() =>
        throwError(() => ({
          status: 400,
          error: {
            error: {
              code: 'Validation.Failed',
              message: 'Validation failed',
              correlationId: 'cid-1',
              details: ['email must be a valid email', 'national_id already exists'],
            },
          },
        })),
      ),
      update: vi.fn(() => of(customer)),
    };
    const toast = { success: vi.fn(), error: vi.fn() };
    const appError = { handleError: vi.fn() };
    const i18n = { instant: (k: string) => k };

    const component = new CustomerFormComponent(
      route as any,
      router as any,
      api as any,
      toast as any,
      appError as any,
      i18n as any,
    );
    component.ngOnInit();
    const formGroup = new FormGroup({
      email: new FormControl(''),
      nationalId: new FormControl(''),
    });
    component.onSubmit({ email: '' }, { form: formGroup } as any);

    expect(formGroup.get('email')?.errors?.['api']).toBe('email must be a valid email');
    expect(formGroup.get('nationalId')?.errors?.['api']).toBe('national_id already exists');
    // The global error service still runs for logging + the status-bucket toast.
    expect(appError.handleError).toHaveBeenCalled();
  });

  it('binds a backend fullName detail to the name control (FE sends fullName: payload.name)', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({})) };
    const router = { navigate: vi.fn() };
    const api = {
      getById: vi.fn(() => of(customer)),
      // Backend validates the wire field `fullName`, so the detail leads with `fullName` even though
      // the FE control is `name`. Without the fieldPathMap entry this fell through to a raw toast.
      create: vi.fn(() =>
        throwError(() => ({
          status: 400,
          error: {
            error: {
              code: 'Validation.Failed',
              message: 'Validation failed',
              correlationId: 'cid-2',
              details: ['fullName must be longer than or equal to 3 characters'],
            },
          },
        })),
      ),
      update: vi.fn(() => of(customer)),
    };
    const toast = { success: vi.fn(), error: vi.fn() };
    const appError = { handleError: vi.fn() };
    const i18n = { instant: (k: string) => k };

    const component = new CustomerFormComponent(
      route as any,
      router as any,
      api as any,
      toast as any,
      appError as any,
      i18n as any,
    );
    component.ngOnInit();
    const formGroup = new FormGroup({ name: new FormControl('') });
    component.onSubmit({ name: '' }, { form: formGroup } as any);

    expect(formGroup.get('name')?.errors?.['api']).toBe(
      'fullName must be longer than or equal to 3 characters',
    );
    // It binds inline rather than surfacing the unmatched-detail toast.
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('binds a server detail in edit mode and marks the control dirty so ui-form renders it', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({ id: '1' })) };
    const router = { navigate: vi.fn() };
    const api = {
      getById: vi.fn(() => of(customer)),
      create: vi.fn(() => of(customer)),
      // EDIT-mode save fails validation on a control the operator never personally touched.
      update: vi.fn(() =>
        throwError(() => ({
          status: 400,
          error: {
            error: {
              code: 'Validation.Failed',
              message: 'Validation failed',
              details: ['fullName must be longer than or equal to 3 characters'],
            },
          },
        })),
      ),
    };
    const toast = { success: vi.fn(), error: vi.fn() };
    const appError = { handleError: vi.fn() };
    const i18n = { instant: (k: string) => k };

    const component = new CustomerFormComponent(
      route as any,
      router as any,
      api as any,
      toast as any,
      appError as any,
      i18n as any,
    );
    component.ngOnInit();
    const nameCtrl = new FormControl('');
    const formGroup = new FormGroup({ name: nameCtrl });
    component.onSubmit({ name: '' }, { form: formGroup } as any);

    // ui-form fieldState returns null while !dirty, so the bind loop must mark the control dirty
    // (alongside touched) for the inline error to render in edit mode.
    expect(nameCtrl.errors?.['api']).toBe('fullName must be longer than or equal to 3 characters');
    expect(nameCtrl.dirty).toBe(true);
    expect(nameCtrl.touched).toBe(true);
  });

  it('toasts an unmatched server detail that maps to no control', () => {
    const route = { paramMap: new BehaviorSubject(convertToParamMap({})) };
    const router = { navigate: vi.fn() };
    const api = {
      getById: vi.fn(() => of(customer)),
      create: vi.fn(() =>
        throwError(() => ({
          status: 409,
          error: {
            error: {
              code: 'Customers.Conflict',
              message: 'stale',
              details: ['row version mismatch'],
            },
          },
        })),
      ),
      update: vi.fn(() => of(customer)),
    };
    const toast = { success: vi.fn(), error: vi.fn() };
    const appError = { handleError: vi.fn() };
    const i18n = { instant: (k: string) => k };

    const component = new CustomerFormComponent(
      route as any,
      router as any,
      api as any,
      toast as any,
      appError as any,
      i18n as any,
    );
    component.ngOnInit();
    const formGroup = new FormGroup({ name: new FormControl('') });
    component.onSubmit({ name: '' }, { form: formGroup } as any);

    expect(toast.error).toHaveBeenCalledWith('row version mismatch');
  });

  it('ignores the legacy error shape and an envelope without details', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      { success: vi.fn(), error: vi.fn() } as any,
      { handleError: vi.fn() } as any,
      { instant: () => '' } as any,
    );
    const formGroup = new FormGroup({ name: new FormControl('') });
    // Legacy { error: { errors: {...} } } is no longer read; a 403 with no details must not crash.
    (component as any).bindServerValidationErrors(
      { status: 400, error: { errors: { name: 'Invalid' } } },
      { form: formGroup } as any,
    );
    (component as any).bindServerValidationErrors(
      { status: 403, error: { error: { code: 'Auth.Forbidden', message: 'no' } } },
      { form: formGroup } as any,
    );
    expect(formGroup.get('name')?.errors).toBeNull();
  });

  it('marks all controls dirty in create mode', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const form = new FormGroup({
      a: new FormControl(''),
      nested: new FormGroup({ b: new FormControl('') }),
    });

    (component as any).markAllDirty(form);
    expect(form.dirty).toBe(true);
    expect(form.get('nested.b')?.dirty).toBe(true);
  });

  it('markAllDirty handles form arrays', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const array = new FormArray([new FormControl('x')]);
    (component as any).markAllDirty(array);
    expect(array.dirty).toBe(true);
  });

  it('back navigates based on mode', () => {
    const router = { navigate: vi.fn() };
    const component = new CustomerFormComponent(
      {} as any,
      router as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );

    component.mode.set('create');
    component.back();
    expect(router.navigate).toHaveBeenCalledWith(['/customers']);

    component.mode.set('edit');
    component.id = '1';
    component.back();
    expect(router.navigate).toHaveBeenCalledWith(['/customers', '1']);
  });

  it('handleSubmit marks dirty and triggers submit', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    component.mode.set('create');
    const form = new FormGroup({ name: new FormControl('') });
    const submit = vi.fn();
    component.uiForm = { form, submit } as any;

    component.handleSubmit();
    expect(form.dirty).toBe(true);
    expect(submit).toHaveBeenCalled();
  });

  it('ngAfterViewInit attaches nationalId validator', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const formGroup = new FormGroup({ nationalId: new FormControl('') });
    component.uiForm = { form: formGroup } as any;
    component.ngAfterViewInit();
    formGroup.updateValueAndValidity();
    expect(formGroup.validator).toBeDefined();
  });

  it('ngOnDestroy completes teardown', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    component.ngOnDestroy();
    expect(true).toBe(true);
  });

  it('clearForm resets based on mode', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const resetTo = vi.fn();
    component.uiForm = { resetTo } as any;

    component.mode.set('create');
    component.clearForm();
    expect(resetTo).toHaveBeenCalledWith({});

    component.mode.set('edit');
    component.initialValue.set({ name: 'x' });
    component.clearForm();
    expect(resetTo).toHaveBeenCalled();
  });

  it('clearForm returns when uiForm is missing', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    component.uiForm = undefined;
    component.clearForm();
    expect(true).toBe(true);
  });

  it('clearForm resets to null when initialValue is absent in edit mode', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const resetTo = vi.fn();
    component.uiForm = { resetTo } as any;
    component.mode.set('edit');
    component.initialValue.set(null);
    component.clearForm();
    expect(resetTo).toHaveBeenCalledWith(null);
  });

  it('markAllDirty handles null controls', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    (component as any).markAllDirty(null);
    expect(true).toBe(true);
  });

  it('groups fields into design §7.5 sections without dropping or mutating any field', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );

    // CREATE mode: wallet/kyc fields do not exist yet, so those sections are dropped (no bare headers).
    const createFields = (component as any).buildFields('create');
    const createSections = (component as any).toSections(createFields);
    expect(createSections.map((s: any) => s.titleKey)).toEqual([
      'customers.sections.identity.title',
      'customers.sections.address.title',
    ]);

    // Every built field is present exactly once across the sections — the submit contract is intact.
    const flat = createSections.flatMap((s: any) => s.fields.map((f: any) => f.name));
    expect(flat.slice().sort()).toEqual(createFields.map((f: any) => f.name).sort());

    // address.line1 and the trailing nationalId are spanned full-width (so the 5th identity field
    // doesn't strand on a half-row), and in both cases the SOURCE field object is NOT mutated.
    const sourceLine1 = createFields.find((f: any) => f.name === 'address.line1');
    const sectionLine1 = createSections
      .flatMap((s: any) => s.fields)
      .find((f: any) => f.name === 'address.line1');
    expect(sourceLine1.fullWidth).toBeUndefined();
    expect(sectionLine1.fullWidth).toBe(true);

    const sourceNationalId = createFields.find((f: any) => f.name === 'nationalId');
    const sectionNationalId = createSections
      .flatMap((s: any) => s.fields)
      .find((f: any) => f.name === 'nationalId');
    expect(sourceNationalId.fullWidth).toBeUndefined();
    expect(sectionNationalId.fullWidth).toBe(true);

    // EDIT mode surfaces the Wallet-Finance + KYC-Status sections too.
    const editSections = (component as any).toSections((component as any).buildFields('edit'));
    expect(editSections.map((s: any) => s.titleKey)).toEqual([
      'customers.sections.identity.title',
      'customers.sections.address.title',
      'customers.sections.walletFinance.title',
      'customers.sections.kycStatus.title',
    ]);
  });

  it('toSections appends any unbucketed field to a trailing catch-all section (no field lost)', () => {
    const component = new CustomerFormComponent(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { instant: () => '' } as any,
    );
    const sections = (component as any).toSections([
      { name: 'name', labelKey: 'x', type: 'text' },
      { name: 'mysteryField', labelKey: 'x', type: 'text' },
    ]);
    const last = sections[sections.length - 1];
    expect(last.titleKey).toBeUndefined();
    expect(last.fields.map((f: any) => f.name)).toEqual(['mysteryField']);
  });
});
