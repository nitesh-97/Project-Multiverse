import type { FastifyInstance } from 'fastify';
import { eventBody, planEditBody, voidBody } from '../schemas';
import type { ProjectService } from '../service';
import { params, query } from './util';

export function registerEventRoutes(app: FastifyInstance, svc: ProjectService): void {
  /**
   * Dry run: "what would this event do?" Returns the schedule and effort impact, the critical-path change and the
   * modules affected. Nothing is written.
   */
  app.post('/projects/:id/events/preview', async (req) => svc.previewEvent(params<{ id: string }>(req).id, eventBody.parse(req.body)));

  /** Records the event, applies its effects, and writes a forecast snapshot. Atomic: a rejected event leaves no trace. */
  app.post('/projects/:id/events', async (req, reply) => {
    const result = svc.recordEvent(params<{ id: string }>(req).id, eventBody.parse(req.body));
    return reply.code(201).send(result);
  });

  app.get('/projects/:id/events', async (req) => {
    const q = query(req);
    return svc.listEvents(params<{ id: string }>(req).id, {
      ...(q.type !== undefined ? { type: q.type } : {}),
      ...(q.phase !== undefined ? { phase: q.phase } : {}),
      ...(q.moduleId !== undefined ? { moduleId: q.moduleId } : {}),
      ...(q.teamId !== undefined ? { teamId: q.teamId } : {}),
      ...(q.status !== undefined ? { status: q.status } : {}),
    });
  });

  app.get('/projects/:id/events/:eventId', async (req) => {
    const { id, eventId } = params<{ id: string; eventId: string }>(req);
    return svc.eventDetail(id, eventId);
  });

  /**
   * Planning changes to modules that have not started, made after the project started: re-estimate, add or remove
   * work, change dependencies. Recorded in history like an event, but it moves the plan as well as the forecast, so it
   * is planning, not delay. Refused for modules that are locked (use an event) and for work that has started.
   */
  app.post('/projects/:id/plan-edits/preview', async (req) => svc.previewPlanEdit(params<{ id: string }>(req).id, planEditBody.parse(req.body)));

  app.post('/projects/:id/plan-edits', async (req, reply) => {
    const result = svc.recordPlanEdit(params<{ id: string }>(req).id, planEditBody.parse(req.body));
    return reply.code(201).send(result);
  });

  app.get('/projects/:id/plan-edits', async (req) => svc.listPlanEdits(params<{ id: string }>(req).id));

  /** Withdraws a mistaken event. It stays in the log; a VOID snapshot records the correction. */
  app.post('/projects/:id/events/:eventId/void', async (req, reply) => {
    const { id, eventId } = params<{ id: string; eventId: string }>(req);
    const result = svc.voidEvent(id, eventId, voidBody.parse(req.body));
    return reply.code(201).send(result);
  });
}
