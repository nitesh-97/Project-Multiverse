import { EffectError, PlanError } from '@multiverse/engine';
import { ZodError } from 'zod';

/** An error with an HTTP status and a stable machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string, id: string): ApiError => new ApiError(404, 'NOT_FOUND', `${what} "${id}" does not exist`);
export const conflict = (code: string, message: string): ApiError => new ApiError(409, code, message);
export const badRequest = (message: string, details?: unknown): ApiError => new ApiError(400, 'BAD_REQUEST', message, details);

export interface ErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

/** Turns anything thrown below the HTTP layer into a status and a body. Unknown errors become 500. */
export function toHttpError(e: unknown): { status: number; body: ErrorBody } {
  if (e instanceof ApiError) {
    return { status: e.status, body: { error: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } };
  }
  if (e instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: 'BAD_REQUEST',
        message: 'The request body is not valid',
        details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  }
  if (e instanceof PlanError) {
    return { status: 422, body: { error: 'INVALID_PLAN', message: e.message, details: e.issues } };
  }
  if (e instanceof EffectError) {
    return { status: 422, body: { error: 'EVENT_REJECTED', message: e.message, ...(e.eventId ? { details: { eventId: e.eventId } } : {}) } };
  }
  if (e instanceof RangeError) {
    return { status: 400, body: { error: 'BAD_REQUEST', message: e.message } };
  }
  if (e instanceof Error && e.message.startsWith('LOCKED:')) {
    return { status: 409, body: { error: 'LOCKED', message: e.message.slice('LOCKED:'.length).trim() } };
  }
  if (e instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/.test(e.message)) {
    return { status: 409, body: { error: 'ALREADY_EXISTS', message: 'An item with that id already exists' } };
  }
  if (e instanceof Error && /FOREIGN KEY constraint failed/.test(e.message)) {
    return { status: 409, body: { error: 'REFERENCE', message: 'The item refers to something that does not exist, or is still referred to' } };
  }
  return { status: 500, body: { error: 'INTERNAL', message: 'Unexpected error' } };
}
