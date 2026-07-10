/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Lightweight quality smoke checks that run without extra dependencies. They complement component
 * a11y/unit coverage and can later be swapped for axe/visual tooling once dependency changes are
 * approved.
 */
import { isVisualArtifactCaptureEnabled } from './test-policy';

export function expectNoHorizontalOverflow(): void {
  cy.document().then(doc => {
    const root = doc.documentElement;
    expect(root.scrollWidth, 'document scrollWidth').to.be.at.most(root.clientWidth + 1);
  });
}

export function expectA11ySmoke(): void {
  cy.get('main, [role="main"]').should('exist');

  cy.get('button').each($button => {
    if (!$button.is(':visible')) return;
    const element = $button[0];
    const visibleText = element.textContent?.trim() ?? '';
    const hasName =
      visibleText.length > 0 ||
      !!element.getAttribute('aria-label') ||
      !!element.getAttribute('aria-labelledby') ||
      !!element.getAttribute('title');
    expect(hasName, describeElement(element)).to.eq(true);
  });

  cy.get('input:not([type="hidden"]), select, textarea').each($control => {
    if (!$control.is(':visible')) return;
    const element = $control[0] as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const id = element.id;
    const hasName =
      !!element.getAttribute('aria-label') ||
      !!element.getAttribute('aria-labelledby') ||
      !!element.closest('label') ||
      (id ? !!element.ownerDocument.querySelector(`label[for="${escapeAttribute(id)}"]`) : false);
    expect(hasName, describeElement(element)).to.eq(true);
  });

  cy.get('body').then($body => {
    $body.find('[role="tabpanel"]').each((_index, element) => {
      expect(element.getAttribute('aria-labelledby'), describeElement(element))
        .to.be.a('string')
        .and.not.eq('');
    });
  });
}

export function expectVisualLayoutSmoke(): void {
  cy.byTestId('app-shell').should('be.visible');
  cy.byTestId('main-content').should('be.visible');
  cy.document().then(doc => {
    const header = doc.querySelector('.header');
    const main = doc.querySelector('[data-testid="main-content"]');
    if (!header || !main) return;
    const headerRect = header.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    expect(mainRect.width, 'main width').to.be.greaterThan(280);
    expect(mainRect.bottom, 'main bottom').to.be.greaterThan(mainRect.top);
    expect(headerRect.bottom, 'header bottom').to.be.greaterThan(headerRect.top);
  });
}

// Honesty note: this is a DEV-BUILD sanity bound (catches pathological hangs), not a performance
// budget — real budgets live in the CI bundle/perf gates.
export function expectPerformanceSmoke(maxNavigationMs = 6000): void {
  cy.window().then(win => {
    const entry = win.performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    const duration = entry?.duration ?? win.performance.now();
    expect(duration, 'navigation duration').to.be.lessThan(maxNavigationMs);
  });
}

export function captureVisualArtifact(name: string): void {
  if (!isVisualArtifactCaptureEnabled()) return;
  cy.screenshot(name, { capture: 'viewport' });
}

function escapeAttribute(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function describeElement(element: Element): string {
  const id = element.id ? `#${element.id}` : '';
  const testId = element.getAttribute('data-testid');
  const marker = testId ? `[data-testid="${testId}"]` : id;
  return `${element.tagName.toLowerCase()}${marker} has an accessible name`;
}
