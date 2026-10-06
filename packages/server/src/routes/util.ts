import type { FastifyRequest } from 'fastify';

/** Route params and query strings arrive as untyped strings; these name what each route expects. */
export const params = <T extends Record<string, string>>(req: FastifyRequest): T => req.params as T;
export const query = (req: FastifyRequest): Record<string, string | undefined> => req.query as Record<string, string | undefined>;
