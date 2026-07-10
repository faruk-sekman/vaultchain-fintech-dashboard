/*
 * Copyright (c) 2026 Fintech Dashboard contributors.
 *
 * Single safe error envelope with a stable code. Internal (non-HTTP)
 * errors never leak detail to the client — a generic message is returned and the
 * real error is logged server-side.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlationId: string;
  };
}

const PRISMA_DATABASE_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'P1000',
  'P1001',
  'P1002',
  'P1017',
  'P2021',
  'P2022',
  'P2024',
]);
const PRISMA_NOT_FOUND_CODES = new Set(['P2001', 'P2015', 'P2025']);
const PRISMA_CONFLICT_CODES = new Set(['P2002', 'P2003', 'P2014']);

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const header = request.headers['x-correlation-id'];
    const correlationId = (Array.isArray(header) ? header[0] : header) ?? randomUUID();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'Internal.Error';
    let message = 'An unexpected error occurred.';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      code = exception.name.replace(/Exception$/, '');
      if (typeof response === 'string') {
        message = response;
      } else if (response !== null && typeof response === 'object') {
        const body = response as Record<string, unknown>;
        message = typeof body.message === 'string' ? body.message : message;
        // Domain errors throw `{ code, message }` — prefer that stable code over the class name.
        if (typeof body.code === 'string') {
          code = body.code;
        }
        if (Array.isArray(body.message)) {
          message = 'Request validation failed.';
          details = body.message;
          code = 'Validation.Failed';
        }
      }
    } else if (isDatabaseUnavailableError(exception)) {
      status = HttpStatus.SERVICE_UNAVAILABLE;
      code = 'Database.Unavailable';
      message = 'Database is temporarily unavailable.';
      this.logger.error(
        `Database unavailable (correlationId=${correlationId}, prismaCode=${exception.code})`,
        exception.stack,
      );
    } else if (isPrismaKnownRequestError(exception)) {
      const mapped = mapExpectedPrismaError(exception.code);
      if (mapped) {
        status = mapped.status;
        code = mapped.code;
        message = mapped.message;
      } else {
        this.logger.error(
          `Unhandled Prisma error (correlationId=${correlationId}, prismaCode=${exception.code})`,
          exception.stack,
        );
      }
    } else {
      // Unknown/internal error: log server-side, return a generic envelope (no leak).
      this.logger.error(
        `Unhandled exception (correlationId=${correlationId})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: ErrorBody = { error: { code, message, correlationId } };
    if (details !== undefined) {
      body.error.details = details;
    }
    void reply.status(status).send(body);
  }
}

function isDatabaseUnavailableError(exception: unknown): exception is Prisma.PrismaClientKnownRequestError {
  return isPrismaKnownRequestError(exception) && PRISMA_DATABASE_UNAVAILABLE_CODES.has(exception.code);
}

function isPrismaKnownRequestError(exception: unknown): exception is Prisma.PrismaClientKnownRequestError {
  return exception instanceof Prisma.PrismaClientKnownRequestError;
}

function mapExpectedPrismaError(code: string): { status: number; code: string; message: string } | null {
  if (PRISMA_NOT_FOUND_CODES.has(code)) {
    return {
      status: HttpStatus.NOT_FOUND,
      code: 'Resource.NotFound',
      message: 'Requested resource was not found.',
    };
  }
  if (PRISMA_CONFLICT_CODES.has(code)) {
    return {
      status: HttpStatus.CONFLICT,
      code: 'Resource.Conflict',
      message: 'Resource already exists or violates a constraint.',
    };
  }
  return null;
}
