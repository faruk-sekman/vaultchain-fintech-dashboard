/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 */
import { ArgumentsHost, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AllExceptionsFilter } from './all-exceptions.filter';

function hostWith(
  headers: FastifyRequest['headers'] = {},
): { host: ArgumentsHost; reply: Pick<FastifyReply, 'status' | 'send'> & { status: jest.Mock; send: jest.Mock } } {
  const reply = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
  } as Pick<FastifyReply, 'status' | 'send'> & { status: jest.Mock; send: jest.Mock };
  const request = { headers } as FastifyRequest;

  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return { host, reply };
}

describe('AllExceptionsFilter', () => {
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    loggerError.mockRestore();
  });

  it.each(['P2021', 'ECONNREFUSED'])('maps Prisma database availability error %s to a safe 503 envelope', (code) => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-1' });
    const error = new Prisma.PrismaClientKnownRequestError('table missing', {
      code,
      clientVersion: 'test',
    });

    filter.catch(error, host);

    expect(reply.status).toHaveBeenCalledWith(503);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'Database.Unavailable',
        message: 'Database is temporarily unavailable.',
        correlationId: 'corr-1',
      },
    });
  });

  it('keeps unknown errors generic 500 responses', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-2' });

    filter.catch(new Error('boom'), host);

    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'Internal.Error',
        message: 'An unexpected error occurred.',
        correlationId: 'corr-2',
      },
    });
  });

  it('maps expected Prisma not-found errors to a safe 404 envelope', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-3' });
    const error = new Prisma.PrismaClientKnownRequestError('record missing', {
      code: 'P2025',
      clientVersion: 'test',
    });

    filter.catch(error, host);

    expect(reply.status).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'Resource.NotFound',
        message: 'Requested resource was not found.',
        correlationId: 'corr-3',
      },
    });
  });

  it('maps expected Prisma uniqueness errors to a safe 409 envelope', () => {
    const filter = new AllExceptionsFilter();
    const { host, reply } = hostWith({ 'x-correlation-id': 'corr-4' });
    const error = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });

    filter.catch(error, host);

    expect(reply.status).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith({
      error: {
        code: 'Resource.Conflict',
        message: 'Resource already exists or violates a constraint.',
        correlationId: 'corr-4',
      },
    });
  });
});
