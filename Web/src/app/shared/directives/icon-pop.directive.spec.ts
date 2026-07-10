/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for IconPopDirective (audit 9C Web). Drives the click re-arm and the animationend
 * teardown, including the guard that ignores a child glyph's redraw animation bubbling up.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ElementRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { IconPopDirective } from './icon-pop.directive';

describe('IconPopDirective', () => {
  let node: HTMLElement;
  let directive: IconPopDirective;

  beforeEach(() => {
    node = document.createElement('button');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [{ provide: ElementRef, useValue: new ElementRef(node) }],
    });
    directive = TestBed.runInInjectionContext(() => new IconPopDirective());
  });

  it('arms the pop class on click', () => {
    directive.onClick();
    expect(node.classList.contains('is-popping')).toBe(true);
  });

  it('clears the class on the host’s own pop animationend', () => {
    node.classList.add('is-popping');
    directive.onAnimationEnd({
      target: node,
      animationName: 'ui-icon-pop',
    } as unknown as AnimationEvent);
    expect(node.classList.contains('is-popping')).toBe(false);
  });

  it('ignores a bubbled child redraw animationend', () => {
    node.classList.add('is-popping');
    directive.onAnimationEnd({
      target: document.createElement('i'),
      animationName: 'ui-icon-redraw',
    } as unknown as AnimationEvent);
    expect(node.classList.contains('is-popping')).toBe(true);
  });
});
