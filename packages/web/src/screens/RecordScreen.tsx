import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { useResource } from '../api/useResource';
import { EventLog } from '../components/EventLog';
import { ModuleLocks } from '../components/ModuleLocks';
import { TemplateForm } from '../components/TemplateForm';
import { Card, ErrorNote, Status } from '../components/ui';
import { TEMPLATES, TEMPLATE_GROUPS, whyUnavailable } from '../lib/templates';
import type { FormContext, Template } from '../lib/templates';
import { useProject } from '../state';

/** Where changes are recorded: standard things as buttons with an example, then a short form, then a preview. */
export function RecordScreen() {
  const { projectId, detail, version, refresh, today, go } = useProject();
  // A project that has not started has no forecast to read yet: only the module locks are shown.
  const scope = detail.started ? projectId : null;
  const tasks = useResource(scope, version, (signal) => api.currentTasks(projectId, signal));
  const events = useResource(scope, version, (signal) => api.events(projectId, signal));
  const planEdits = useResource(scope, version, (signal) => api.planEdits(projectId, signal));
  const forecast = useResource(scope, version, (signal) => api.forecast(projectId, signal));

  const [chosen, setChosen] = useState<Template | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Forms start on today, or on the last status date if that is later: the forecast never goes backwards.
  const lastStatus = forecast.data?.asOf ?? null;
  const startDate = lastStatus && lastStatus > today ? lastStatus : today;

  const ctx: FormContext | null = useMemo(
    () =>
      detail.started && tasks.data
        ? { today: startDate, tasks: tasks.data, teams: detail.teams, modules: detail.modules, features: detail.features, deliveryTaskId: detail.project.deliveryTaskId, phases: detail.project.phases }
        : null,
    [detail, tasks.data, startDate],
  );

  const error = tasks.error ?? events.error ?? planEdits.error ?? forecast.error;

  return (
    <div className="screen">
      {error ? <ErrorNote error={error} onRetry={() => { tasks.reload(); events.reload(); planEdits.reload(); forecast.reload(); }} /> : null}

      {done ? (
        <div className="notice" role="status">
          <Status health="good">Recorded: {done}</Status>
          <span style={{ flex: 1 }} />
          <button type="button" className="button small" onClick={() => go({ tab: 'timeline' })}>
            See it on the timeline
          </button>
          <button type="button" className="button small quiet" onClick={() => setDone(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <ModuleLocks />

      {ctx ? (
        <>
          <Card title="What happened?" sub="Pick the nearest match. You will see exactly what it does to the forecast before anything is recorded.">
            <div className="template-groups">
              {TEMPLATE_GROUPS.map((group) => (
                <div className="template-group" key={group}>
                  <h3>{group}</h3>
                  <div className="template-grid">
                    {TEMPLATES.filter((t) => t.group === group).map((t) => {
                      const why = whyUnavailable(t, ctx);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          className="template-button"
                          aria-pressed={chosen?.id === t.id}
                          disabled={why !== null}
                          onClick={() => {
                            setChosen(t);
                            setDone(null);
                          }}
                        >
                          <span className="t-name">{t.title}</span>
                          <span className="t-example">e.g. {t.example}</span>
                          {why ? <span className="t-why">{why}</span> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {chosen ? (
            <TemplateForm
              key={chosen.id}
              template={chosen}
              ctx={ctx}
              onCancel={() => setChosen(null)}
              onRecorded={(message) => {
                setChosen(null);
                setDone(message);
                refresh();
              }}
            />
          ) : null}

          <EventLog events={events.data ?? []} planEdits={planEdits.data ?? []} tasks={tasks.data ?? []} defaultDate={startDate} />
        </>
      ) : null}
    </div>
  );
}
