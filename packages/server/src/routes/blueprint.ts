import type { FastifyInstance } from 'fastify';
import { notFound } from '../errors';
import {
  capacityBody,
  dependencyBody,
  featureBody,
  featurePatch,
  moduleBody,
  modulePatch,
  taskBody,
  taskPatch,
  teamBody,
  teamPatch,
} from '../schemas';
import type { ProjectService } from '../service';
import { params, query } from './util';

/**
 * Granular blueprint editing. Before the project starts these are plain edits. Afterwards the DB refuses changes to
 * locked modules (409 LOCKED), and changes to unlocked ones rebuild history under a new plan revision.
 */
export function registerBlueprintRoutes(app: FastifyInstance, svc: ProjectService): void {
  // teams
  app.post('/projects/:id/teams', async (req, reply) => {
    const { id } = params<{ id: string }>(req);
    const body = teamBody.parse(req.body);
    svc.edit(id, (s) => s.insertTeam(id, body), { replan: false });
    return reply.code(201).send(body);
  });
  app.patch('/projects/:id/teams/:teamId', async (req) => {
    const { id, teamId } = params<{ id: string; teamId: string }>(req);
    const { name } = teamPatch.parse(req.body);
    if (svc.edit(id, (s) => s.updateTeam(id, teamId, name), { replan: false }) === 0) throw notFound('Team', teamId);
    return { id: teamId, name };
  });
  app.delete('/projects/:id/teams/:teamId', async (req, reply) => {
    const { id, teamId } = params<{ id: string; teamId: string }>(req);
    if (svc.edit(id, (s) => s.deleteTeam(id, teamId), { replan: false }) === 0) throw notFound('Team', teamId);
    return reply.code(204).send();
  });

  // capacity: the earliest row per team is its planned headcount
  app.post('/projects/:id/capacity', async (req, reply) => {
    const { id } = params<{ id: string }>(req);
    const body = capacityBody.parse(req.body);
    svc.edit(id, (s) => s.upsertCapacity(id, body), { replan: false });
    return reply.code(201).send(body);
  });
  app.delete('/projects/:id/capacity', async (req, reply) => {
    const { id } = params<{ id: string }>(req);
    const { teamId, from } = query(req);
    if (!teamId || !from) throw notFound('Capacity row', `${teamId ?? '?'}@${from ?? '?'} (pass ?teamId=&from=)`);
    if (svc.edit(id, (s) => s.deleteCapacity(id, teamId, from), { replan: false }) === 0) throw notFound('Capacity row', `${teamId}@${from}`);
    return reply.code(204).send();
  });

  // modules
  app.post('/projects/:id/modules', async (req, reply) => {
    const { id } = params<{ id: string }>(req);
    const body = moduleBody.parse(req.body);
    svc.edit(id, (s) => s.insertModule(id, body));
    return reply.code(201).send(body);
  });
  app.patch('/projects/:id/modules/:moduleId', async (req) => {
    const { id, moduleId } = params<{ id: string; moduleId: string }>(req);
    const patch = modulePatch.parse(req.body);
    if (svc.edit(id, (s) => s.updateModule(id, moduleId, patch)) === 0) throw notFound('Module', moduleId);
    return svc.projectView(id).modules.find((m) => m.id === moduleId);
  });
  app.delete('/projects/:id/modules/:moduleId', async (req, reply) => {
    const { id, moduleId } = params<{ id: string; moduleId: string }>(req);
    if (svc.edit(id, (s) => s.deleteModule(id, moduleId)) === 0) throw notFound('Module', moduleId);
    return reply.code(204).send();
  });

  // tasks
  app.post('/projects/:id/tasks', async (req, reply) => {
    const { id } = params<{ id: string }>(req);
    const body = taskBody.parse(req.body);
    svc.edit(id, (s) => s.insertTask(id, body));
    return reply.code(201).send(body);
  });
  app.patch('/projects/:id/tasks/:taskId', async (req) => {
    const { id, taskId } = params<{ id: string; taskId: string }>(req);
    const patch = taskPatch.parse(req.body);
    if (svc.edit(id, (s) => s.updateTask(id, taskId, patch)) === 0) throw notFound('Task', taskId);
    return svc.store.getTask(id, taskId);
  });
  app.delete('/projects/:id/tasks/:taskId', async (req, reply) => {
    const { id, taskId } = params<{ id: string; taskId: string }>(req);
    if (svc.edit(id, (s) => s.deleteTask(id, taskId)) === 0) throw notFound('Task', taskId);
    return reply.code(204).send();
  });

  // dependencies (finish-to-start)
  app.post('/projects/:id/dependencies', async (req, reply) => {
    const { id } = params<{ id: string }>(req);
    const body = dependencyBody.parse(req.body);
    svc.edit(id, (s) => s.insertDependency(id, body.predecessorId, body.successorId));
    return reply.code(201).send({ ...body, type: 'FS' });
  });
  app.delete('/projects/:id/dependencies/:predecessorId/:successorId', async (req, reply) => {
    const { id, predecessorId, successorId } = params<{ id: string; predecessorId: string; successorId: string }>(req);
    if (svc.edit(id, (s) => s.deleteDependency(id, predecessorId, successorId)) === 0) {
      throw notFound('Dependency', `${predecessorId} -> ${successorId}`);
    }
    return reply.code(204).send();
  });

  // features
  app.post('/projects/:id/features', async (req, reply) => {
    const { id } = params<{ id: string }>(req);
    const body = featureBody.parse(req.body);
    svc.edit(id, (s) => s.insertFeature(id, { id: body.id, name: body.name, moduleIds: body.moduleIds, ...(body.sharedTaskId !== undefined ? { sharedTaskId: body.sharedTaskId } : {}) }), { replan: false });
    return reply.code(201).send(body);
  });
  app.patch('/projects/:id/features/:featureId', async (req) => {
    const { id, featureId } = params<{ id: string; featureId: string }>(req);
    const patch = featurePatch.parse(req.body);
    if (svc.edit(id, (s) => s.updateFeature(id, featureId, patch), { replan: false }) === 0) throw notFound('Feature', featureId);
    return svc.projectView(id).features.find((f) => f.id === featureId);
  });
  app.delete('/projects/:id/features/:featureId', async (req, reply) => {
    const { id, featureId } = params<{ id: string; featureId: string }>(req);
    if (svc.edit(id, (s) => s.deleteFeature(id, featureId), { replan: false }) === 0) throw notFound('Feature', featureId);
    return reply.code(204).send();
  });
}
