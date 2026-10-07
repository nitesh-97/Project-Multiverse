import type { FastifyInstance } from 'fastify';
import { badRequest } from '../errors';
import type { ProjectService } from '../service';
import { params, query } from './util';

/** Read-only views over the project's history. */
export function registerViewRoutes(app: FastifyInstance, svc: ProjectService): void {
  /** The current forecast: the latest snapshot, with per-task dates, float and the critical path. */
  app.get('/projects/:id/forecast', async (req) => svc.forecast(params<{ id: string }>(req).id));

  /** Forecast history. Summaries by default; `?full=true` includes every task in every snapshot. */
  app.get('/projects/:id/snapshots', async (req) => svc.snapshots(params<{ id: string }>(req).id, query(req).full === 'true'));

  /** One snapshot, with why it differs from the one before. */
  app.get('/projects/:id/snapshots/:revision', async (req) => {
    const { id, revision } = params<{ id: string; revision: string }>(req);
    const n = Number(revision);
    if (!Number.isInteger(n) || n < 0) throw badRequest('revision must be a non-negative integer');
    return svc.snapshot(id, n);
  });

  /** The Multiverse view: the original line plus one branch per deviating module. */
  app.get('/projects/:id/timeline', async (req) => svc.timeline(params<{ id: string }>(req).id));

  /** Delivery forecast drift and the first snapshot that was later than the original date. */
  app.get('/projects/:id/history', async (req) => svc.history(params<{ id: string }>(req).id));

  app.get('/projects/:id/milestones/:taskId/history', async (req) => {
    const { id, taskId } = params<{ id: string; taskId: string }>(req);
    return svc.milestone(id, taskId);
  });

  app.get('/projects/:id/advisories', async (req) => {
    const q = query(req);
    const min = q.minModules === undefined ? undefined : Number(q.minModules);
    if (min !== undefined && (!Number.isInteger(min) || min < 1)) throw badRequest('minModules must be a positive integer');
    return svc.advisories(params<{ id: string }>(req).id, min);
  });

  /**
   * Who or what caused the delay. `?strategy=sequential` (default), `counterfactual`, or `both` (side by side, as the
   * retrospective shows them).
   */
  app.get('/projects/:id/attribution', async (req) => {
    const id = params<{ id: string }>(req).id;
    const strategy = query(req).strategy ?? 'sequential';
    return strategy === 'both' ? svc.attributionBoth(id) : svc.attribution(id, strategy);
  });
}
