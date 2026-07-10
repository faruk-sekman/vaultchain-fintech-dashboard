/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Unit tests for RealtimeController (file-based ≥90% coverage round). RealtimeService + JwtService +
 * FastifyReply mocked; no DB/HTTP. Covers the controller's OWN logic:
 *   - streamToken signs a MINIMAL-scope credential ({ sub, scope: 'stream:read' }, 60s) and sets it
 *     as the httpOnly `ftd_stream` cookie (no body returned).
 *   - stream() subscribes via the RECIPIENT-SCOPED `scopedStream(subject)`, maps each
 *     event to `{ data: event }`, and merges in a NAMED 25s `ping` keepalive (verified with fake
 *     timers + a Subject source).
 */
import { Subject } from 'rxjs';
import type { JwtService } from '@nestjs/jwt';
import type { FastifyReply } from 'fastify';
import type { AuthPrincipal } from '../../common/auth/auth-principal';
import { RealtimeController } from './realtime.controller';
import type { DashboardEvent, RealtimeService } from './realtime.service';

interface SseMessage {
  data: string | object;
  type?: string;
}

function makeReply() {
  return { setCookie: jest.fn() } as unknown as FastifyReply & { setCookie: jest.Mock };
}

const user = { sub: 'op-1', permissions: ['customers.read'] } as AuthPrincipal;

describe('RealtimeController', () => {
  describe('streamToken', () => {
    it('signs a minimal-scope 60s credential and sets it as the ftd_stream httpOnly cookie', async () => {
      const realtime = { scopedStream: jest.fn() } as unknown as RealtimeService;
      const jwt = { signAsync: jest.fn().mockResolvedValue('signed-stream-jwt') } as unknown as JwtService & {
        signAsync: jest.Mock;
      };
      const controller = new RealtimeController(realtime, jwt);
      const reply = makeReply();

      const res = await controller.streamToken(user, reply);

      expect(res).toBeUndefined();
      expect(jwt.signAsync).toHaveBeenCalledWith(
        { sub: 'op-1', scope: 'stream:read' },
        { expiresIn: '60s' },
      );
      expect(reply.setCookie).toHaveBeenCalledWith(
        'ftd_stream',
        'signed-stream-jwt',
        expect.objectContaining({ httpOnly: true, path: '/api/v1/dashboard', maxAge: 60 }),
      );
    });
  });

  describe('stream', () => {
    afterEach(() => jest.useRealTimers());

    it('subscribes via scopedStream(subject) and maps each event into an SSE { data: event } message', () => {
      const scoped$ = new Subject<DashboardEvent>();
      const scopedStream = jest.fn(() => scoped$);
      const realtime = { scopedStream } as unknown as RealtimeService;
      const jwt = {} as unknown as JwtService;
      const controller = new RealtimeController(realtime, jwt);

      const received: SseMessage[] = [];
      const sub = controller.stream(user).subscribe((m) => received.push(m));

      // The controller MUST scope to the authenticated subject (security gate).
      expect(scopedStream).toHaveBeenCalledWith('op-1');

      const event = { id: 'e1', type: 'customer.created', at: '2026-06-29T00:00:00Z' } as unknown as DashboardEvent;
      scoped$.next(event);

      expect(received).toContainEqual({ data: event });
      sub.unsubscribe();
    });

    it('NAMES a private notification.created event so the browser fires its addEventListener (recipient badge/list)', () => {
      const scoped$ = new Subject<DashboardEvent>();
      const realtime = { scopedStream: jest.fn(() => scoped$) } as unknown as RealtimeService;
      const jwt = {} as unknown as JwtService;
      const controller = new RealtimeController(realtime, jwt);

      const received: SseMessage[] = [];
      const sub = controller.stream(user).subscribe((m) => received.push(m));

      const event = {
        id: 'n1',
        type: 'notification.created',
        at: '2026-06-29T00:00:00Z',
      } as unknown as DashboardEvent;
      scoped$.next(event);

      // The private event MUST be NAMED `notification.created` (not the default `message`) so the FE's
      // addEventListener('notification.created') fires; broadcast customer.* events stay unnamed.
      expect(received).toContainEqual({ type: 'notification.created', data: event });
      sub.unsubscribe();
    });

    it('emits a NAMED 25s ping keepalive that never collides with onmessage data', () => {
      jest.useFakeTimers();
      const scoped$ = new Subject<DashboardEvent>();
      const realtime = { scopedStream: jest.fn(() => scoped$) } as unknown as RealtimeService;
      const jwt = {} as unknown as JwtService;
      const controller = new RealtimeController(realtime, jwt);

      const received: SseMessage[] = [];
      const sub = controller.stream(user).subscribe((m) => received.push(m));

      // Nothing before the keepalive interval elapses.
      jest.advanceTimersByTime(24_999);
      expect(received).toHaveLength(0);

      // The 25s tick produces a named `ping` event.
      jest.advanceTimersByTime(1);
      expect(received).toContainEqual({ type: 'ping', data: 'keepalive' });

      sub.unsubscribe();
    });
  });
});
