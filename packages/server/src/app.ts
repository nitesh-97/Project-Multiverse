import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Db } from './db/database';
import { toHttpError } from './errors';
import { registerBlueprintRoutes } from './routes/blueprint';
import { registerEventRoutes } from './routes/events';
import { registerProjectRoutes } from './routes/projects';
import { registerViewRoutes } from './routes/views';
import { ProjectService } from './service';
import type { ServiceOptions } from './service';

export interface AppOptions extends ServiceOptions {
  db: Db;
  logger?: boolean;
  /** A built web app (packages/web/dist) to serve at `/`. Without it only the API is served. */
  webRoot?: string | undefined;
}

/** The page loads its own script and styles and talks only to this server. */
const PAGE_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface App {
  server: FastifyInstance;
  service: ProjectService;
}

/** Builds the HTTP app around an open database. Nothing is listening until `server.listen` is called. */
export function buildApp(options: AppOptions): App {
  const server = Fastify({ logger: options.logger ?? false });
  const service = new ProjectService(options.db, options.now ? { now: options.now } : {});

  server.setErrorHandler((err, req, reply) => {
    // Fastify's own client errors (malformed JSON, unsupported media type) carry a 4xx status.
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Bad request' });
    }
    const { status: code, body } = toHttpError(err);
    if (code >= 500) req.log.error(err);
    return reply.code(code).send(body);
  });

  server.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: 'NOT_FOUND', message: `No route for ${req.method} ${req.url}` }),
  );

  registerProjectRoutes(server, service);
  registerBlueprintRoutes(server, service);
  registerEventRoutes(server, service);
  registerViewRoutes(server, service);

  if (options.webRoot) {
    // Registered last, and only for what the API does not answer: a path that is neither a file nor a route is still
    // the API's JSON 404.
    void server.register(fastifyStatic, {
      root: options.webRoot,
      cacheControl: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.header('Content-Security-Policy', PAGE_POLICY);
          res.header('Cache-Control', 'no-cache');
        } else {
          // Built file names carry a hash of their contents, so they can be kept for good.
          res.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  return { server, service };
}
