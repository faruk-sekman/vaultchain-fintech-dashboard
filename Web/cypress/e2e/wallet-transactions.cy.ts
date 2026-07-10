/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { customerDetail, visitCustomerDetail } from '../support/screens/customer-detail.screen';

describe('Enterprise wallet and transaction flows', () => {
  it('updates wallet limits and recovers from an optimistic-concurrency conflict', () => {
    const api = visitCustomerDetail();

    customerDetail.fillWalletLimits('6000', '16000');
    // ANOTHER operator changes the wallet after our form was seeded: the stored rowVersion moves
    // 3 → 4 (and the limits shift), so our save below carries a stale rowVersion and must 409 —
    // exactly the wallets.service.ts semantics (retrying the SAME rowVersion would 409 forever).
    api.bumpWalletVersion();
    customerDetail.saveWalletLimits();

    cy.wait('@updateWalletLimits').then(interception => {
      expect(interception.response?.statusCode).to.eq(409);
      expect(interception.response?.body.error.code).to.eq('Wallets.Conflict');
      expect(interception.request.body).to.deep.equal({
        dailyLimit: 6000,
        monthlyLimit: 16000,
        rowVersion: 3,
      });
    });

    // The operator-visible surface: the errors.code.Wallets.Conflict toast (visitEnterprise pins
    // lang=en; the key exists in BOTH en.json and tr.json, so the copy below is the EN resolution).
    cy.contains(
      '[role="alert"]',
      'The wallet changed while you were viewing it. Reload and try again.',
    ).should('be.visible');

    // Conflict recovery: the panel re-fetches the wallet and re-seeds the form with the fresh
    // values + rowVersion (the other operator's 5500/16000 @ rowVersion 4).
    cy.wait('@getWallet');
    customerDetail.expectWalletLimitValues('5500', '16000');

    // A second save now carries the FRESH rowVersion and succeeds (request-payload assert — the
    // stub echo is not the contract, the submitted rowVersion is).
    customerDetail.fillWalletLimits('6000', '16000');
    customerDetail.saveWalletLimits();
    cy.wait('@updateWalletLimits').then(interception => {
      expect(interception.response?.statusCode).to.eq(200);
      expect(interception.request.body).to.deep.equal({
        dailyLimit: 6000,
        monthlyLimit: 16000,
        rowVersion: 4,
      });
    });
    customerDetail.assertWalletMeterVisible();
  });

  it('creates a transaction and proves filtered visibility against the ledger query', () => {
    visitCustomerDetail();
    cy.wait('@listTransactions');

    customerDetail.createDeposit('42.5', 'E2E salary credit');

    cy.wait('@createTransaction').then(interception => {
      expect(interception.request.headers).to.have.property('idempotency-key');
      expect(interception.request.body).to.include({
        kind: 'DEPOSIT',
        amountMinor: 4250,
        currency: 'TRY',
        targetWalletId: 'w-c-1',
        description: 'E2E salary credit',
      });
    });
    cy.wait('@listTransactions');
    customerDetail.assertTransactionVisible('E2E salary credit');

    customerDetail.filterStatusByIndex(2);
    cy.wait('@listTransactions').then(interception => {
      const params = new URL(interception.request.url).searchParams;
      expect(params.get('filter[status]')).to.eq('POSTED');
    });
    customerDetail.assertTransactionVisible('E2E salary credit');

    customerDetail.filterKindByIndex(2);
    cy.wait('@listTransactions').then(interception => {
      const params = new URL(interception.request.url).searchParams;
      expect(params.get('filter[kind]')).to.eq('WITHDRAWAL');
    });
    customerDetail.assertTransactionHidden('E2E salary credit');
  });
});
