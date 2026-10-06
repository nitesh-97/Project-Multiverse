import { ENGINE_VERSION } from '@multiverse/engine';
import type { FastifyInstance } from 'fastify';
import { blueprintBody, deliveryBody, projectCreate, projectPatch } from '../schemas';
import type { ProjectService } from '../service';
import { notFound } from '../errors';
import { params } from './util';

export function registerProjectRoutes(app: FastifyInstance, svc: ProjectService): void {
  app.get('/health', async () => ({ status: 'ok', engineVersion: ENGINE_VERSION, node: process.version }));

  app.post('/projects', async (req, reply) => {
    const project = svc.createProject(projectCreate.parse(req.body));
    return reply.code(201).send(svc.projectView(project.id));
  });

  app.get('/projects', async () => svc.listProjects());

  app.get('/projects/:id', async (req) => svc.projectView(params<{ id: string }>(req).id));

  /** Name and target date only affect labels. The calendar is frozen once the project has started. */
  app.patch('/projects/:id', async (req) => {
    const { id } = params<{ id: string }>(req);
    const patch = projectPatch.parse(req.body);
    svc.edit(id, (s) => s.updateProject(id, patch), { replan: patch.startDate !== undefined || patch.weekendDays !== undefined || patch.holidays !== undefined });
    return svc.projectView(id);
  });

  app.put('/projects/:id/delivery', async (req) => {
    const { id } = params<{ id: string }>(req);
    const { taskId } = deliveryBody.parse(req.body);
    svc.edit(id, (s, p) => {
      if (!s.getTask(p.id, taskId)) throw notFound('Task', taskId);
      s.updateProject(id, { deliveryTaskId: taskId });
    });
    return svc.projectView(id);
  });

  app.get('/projects/:id/validate', async (req) => svc.validate(params<{ id: string }>(req).id));

  /** The whole blueprint in one call. Only before the project has started. */
  app.put('/projects/:id/blueprint', async (req) => {
    const { id } = params<{ id: string }>(req);
    const validation = svc.replaceBlueprint(id, blueprintBody.parse(req.body));
    return { validation, project: svc.projectView(id) };
  });

  /** Starts execution of a module. The first lock starts the project and writes revision 0. */
  app.post('/projects/:id/modules/:moduleId/lock', async (req) => {
    const { id, moduleId } = params<{ id: string; moduleId: string }>(req);
    svc.lockModule(id, moduleId);
    return svc.projectView(id);
  });

  /** The baseline plan as the engine sees it. */
  app.get('/projects/:id/plan', async (req) => svc.plan(params<{ id: string }>(req).id));

  app.get('/projects/:id/plan-revisions', async (req) => svc.planRevisions(params<{ id: string }>(req).id));

  /** Rebuilds history under a new plan revision using the current engine. Earlier revisions are kept. */
  app.post('/projects/:id/rebuild-history', async (req) => svc.rebuildHistory(params<{ id: string }>(req).id));
}
