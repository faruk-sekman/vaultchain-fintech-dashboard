/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Branch-completion tests for AllExceptionsFilter. The sibling spec covers the Prisma
 * 503/404/409 + generic-500 paths; this file fills the HttpException branches (string vs object
 * response, domain `{ code }` override, class-name-derived code, validation-array → details),
 * the correlationId-generated branch, and the unmapped-Prisma-code log path. Hermetic mocks only.
 */
import { ArgumentsHost, BadRequestException, ForbiddenException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AllExceptionsFilter } from './all-exceptions.filter';

function hostWith(headers: FastifyRequest['headers'] = {}): {
  host: ArgumentsHost;
  reply: { status: jest.Mock; send: jest.Mock };
} {
  const reply = { status: jest.fn().mockReturnThis(), send: jest.fn() };
  const request = { headers } as FastifyRequest;
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply as unknown as FastifyReply,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;
  return { host, reply };
}

describe('AllExceptionsFilter — branch completion', () => {
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    loggerError.mockRestore();
  });

  it('maps an HttpException with a STRING response body, deriving the code from the class name', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-str' });

    filter.catch(new HttpException('teapot', HttpStatus.I_AM_A_TEAPOT), host);

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.I_AM_A_TEAPOT);
    expect(reply.send).toHaveBeenCalledWith({
      error: { code: 'Http', message: 'teapot', correlationId: 'corr-str' },
    });
  });

  it('derives the code from the exception class name when the object body has no `code`', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-fb' });

    // ForbiddenException default object body { statusCode, message, error } — no `code`.
    filter.catch(new ForbiddenException('nope'), host);

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(reply.send).toHaveBeenCalledWith({
      error: { code: 'Forbidden', message: 'nope', correlationId: 'corr-fb' },
    });
  });

  it('prefers a domain `{ code, message }` body over the class-name-derived code', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-dom' });
    const domain = new HttpException(
      { code: 'Customer.AlreadyExists', message: 'duplicate national id' },
      HttpStatus.CONFLICT,
    );

    filter.catch(domain, host);

    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'Customer.AlreadyExists',
        message: 'duplicate national id',
        correlationId: 'corr-dom',
      },
    });
  });

  it('falls back to the generic message when an object body omits a string message', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-nomsg' });
    // Object body without a usable `message` string → keep the default.
    const exc = new HttpException({ foo: 'bar' } as unknown as Record<string, unknown>, HttpStatus.BAD_GATEWAY);

    filter.catch(exc, host);

    const sent = reply.send.mock.calls[0][0];
    expect(sent.error.message).toBe('An unexpected error occurred.');
    expect(sent.error.code).toBe('Http');
  });

  it('maps a class-validator failure (message ARRAY) to Validation.Failed + details', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-val' });
    const messages = ['nationalId must be valid', 'email must be an email'];
    const exc = new BadRequestException(messages);

    filter.catch(exc, host);

    expect(reply.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'Validation.Failed',
        message: 'Request validation failed.',
        correlationId: 'corr-val',
        details: messages,
      },
    });
  });

  it('generates a correlationId when no x-correlation-id header is supplied', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({}); // no correlation header

    filter.catch(new ForbiddenException('x'), host);

    const sent = reply.send.mock.calls[0][0];
    expect(sent.error.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('uses the first value when x-correlation-id is an array header', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': ['c-first', 'c-second'] });

    filter.catch(new ForbiddenException('x'), host);

    expect(reply.send.mock.calls[0][0].error.correlationId).toBe('c-first');
  });

  it('logs and returns a generic 500 for a KNOWN-but-UNMAPPED Prisma error code', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-unmapped' });
    // P2016 is a real PrismaClientKnownRequestError code that is NOT in any of the curated sets.
    const error = new Prisma.PrismaClientKnownRequestError('interpretation error', {
      code: 'P2016',
      clientVersion: 'test',
    });

    filter.catch(error, host);

    // Unmapped → stays the default Internal.Error 500 envelope; the raw error is logged server-side.
    expect(reply.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'Internal.Error',
        message: 'An unexpected error occurred.',
        correlationId: 'corr-unmapped',
      },
    });
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled Prisma error'),
      expect.anything(),
    );
  });

  it('logs a non-Error thrown value (string) without leaking it to the client', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-throwstr' });

    filter.catch('a raw string was thrown', host);

    // Client gets the generic envelope; the raw string only reaches the server log.
    expect(reply.send.mock.calls[0][0].error.message).toBe('An unexpected error occurred.');
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Unhandled exception'),
      'a raw string was thrown',
    );
  });
});
