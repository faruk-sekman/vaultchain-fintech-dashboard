/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { stubEnterpriseApi, visitEnterprise } from '../enterprise-api';

export class LoginScreen {
  visit(path = '/login'): void {
    visitEnterprise(path);
  }

  fill(email: string, password: string): void {
    cy.byTestId('login-email').clear().type(email);
    cy.byTestId('login-password').clear().type(password, { log: false });
  }

  submit(): void {
    cy.byTestId('login-submit').click();
  }

  chooseFirstDemoAccount(): void {
    cy.byTestId('login-demo-card').first().click();
  }

  login(email = 'admin@ftd.local', password = 'Passw0rd!'): void {
    this.fill(email, password);
    this.submit();
  }
}

export class MfaVerifyScreen {
  fillCode(code: string): void {
    cy.byTestId('mfa-verify-code').clear().type(code);
  }

  rememberDevice(): void {
    cy.byTestId('mfa-remember-device').check();
  }

  submitTotp(): void {
    cy.byTestId('mfa-verify-submit').find('button').click();
  }
}

export function loginThroughUi(options: Parameters<typeof stubEnterpriseApi>[0] = {}): void {
  stubEnterpriseApi(options);
  const login = new LoginScreen();
  login.visit();
  login.login();
  cy.wait('@login');
}

export const loginScreen = new LoginScreen();
export const mfaVerifyScreen = new MfaVerifyScreen();
