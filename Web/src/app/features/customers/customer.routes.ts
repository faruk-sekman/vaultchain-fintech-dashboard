/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */

import { Routes } from '@angular/router';
import { permissionGuard } from '@core/auth/permission.guard';
import { provideCustomersState } from '@features/customers/customers.providers';

export const customerRoutes: Routes = [
  {
    // Pathless wrapper (O-6): registers the customers/transactions/kycVerifications NgRx slices at
    // this lazy route so they load with the customers feature (not eagerly at app bootstrap). All
    // child pages (list, detail, forms, web3-risk) share the one injector and its slices.
    path: '',
    providers: [provideCustomersState()],
    children: [
      {
        path: '',
        // Defense-in-depth: the list reads customers (BE gates GET /customers on `customers.read`).
        canActivate: [permissionGuard('customers.read')],
        loadComponent: () =>
          import('@features/customers/pages/customer-list/customer-list.component').then(
            m => m.CustomerListComponent,
          ),
      },
      {
        path: 'new',
        // Defense-in-depth: only operators with `customers.manage` may open the create form by URL.
        canActivate: [permissionGuard('customers.manage')],
        data: { titleKey: 'customers.create' },
        loadComponent: () =>
          import('@features/customers/pages/customer-form/customer-form.component').then(
            m => m.CustomerFormComponent,
          ),
      },
      {
        path: ':id',
        // Defense-in-depth: detail reads a customer (BE gates GET /customers/:id on `customers.read`).
        canActivate: [permissionGuard('customers.read')],
        data: { titleKey: 'customerDetail.title' },
        loadComponent: () =>
          import('@features/customers/pages/customer-detail/customer-detail.component').then(
            m => m.CustomerDetailComponent,
          ),
      },
      {
        path: ':id/edit',
        // A12/K5: edit is Administrator-only — the URL gate mirrors the BE PUT's dedicated
        // `customers.update` permission (create keeps `customers.manage`).
        canActivate: [permissionGuard('customers.update')],
        data: { titleKey: 'customers.edit' },
        loadComponent: () =>
          import('@features/customers/pages/customer-form/customer-form.component').then(
            m => m.CustomerFormComponent,
          ),
      },
      {
        path: ':id/web3-risk',
        // Defense-in-depth: the risk view reads customer + risk data (`customers.read`).
        canActivate: [permissionGuard('customers.read')],
        data: { titleKey: 'web3.title' },
        loadComponent: () =>
          import('@features/customers/pages/web3-risk/web3-risk.component').then(
            m => m.Web3RiskComponent,
          ),
      },
    ],
  },
];
