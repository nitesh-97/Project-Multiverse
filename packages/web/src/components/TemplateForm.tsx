import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChangeExplanation } from '@multiverse/engine';
import { api, describeError } from '../api/client';
import { formatDate } from '../lib/dates';
import { initialCommon, initialValues, modulesFor, phaseOptions, taskName, tasksFor } from '../lib/templates';
import type { Built, Common, Field, FormContext, Template, Values } from '../lib/templates';
import { useProject } from '../state';
import { ChangeDetail } from './ChangeDetail';
import { Card, ErrorNote, StatusIcon } from './ui';

/**
 * One standard form: a few questions, then "what would this do?" with nothing written, then record it. The preview
 * is the same explanation the timeline shows afterwards, so there are no surprises.
 */
export function TemplateForm({ template, ctx, onRecorded, onCancel }: { template: Template; ctx: FormContext; onRecorded: (message: string) => void; onCancel: () => void }) {
  const { projectId, recordingAs, setRecordingAs, detail } = useProject();
  const [values, setValues] = useState<Values>(() => initialValues(template, ctx));
  const [common, setCommon] = useState<Common>(() => initialCommon(ctx, recordingAs));
  const [problems, setProblems] = useState<string[]>([]);
  const [serverError, setServerError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{ built: Extract<Built, { ok: true }>; explanation: ChangeExplanation } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'record' | null>(null);
  const id = useId();

  const edited = () => {
    setPreview(null);
    setServerError(null);
  };
  const setValue = (fieldId: string, value: string | string[]) => {
    setValues((v) => ({ ...v, [fieldId]: value }));
    edited();
  };
  const setCommonField = <K extends keyof Common>(key: K, value: Common[K]) => {
    setCommon((c) => ({ ...c, [key]: value }));
    if (key === 'createdBy') setRecordingAs(String(value));
    edited();
  };

  const run = async () => {
    const built = template.build(values, common, ctx);
    if (!built.ok) {
      setProblems(built.problems);
      setPreview(null);
      return null;
    }
    setProblems([]);
    return built;
  };

  const doPreview = async () => {
    const built = await run();
    if (!built) return;
    setBusy('preview');
    setServerError(null);
    try {
      const res = built.route === 'event' ? await api.previewEvent(projectId, built.draft) : await api.previewPlanEdit(projectId, built.draft);
      setPreview({ built, explanation: res.explanation });
    } catch (e) {
      setServerError(e);
    } finally {
      setBusy(null);
    }
  };

  const doRecord = async () => {
    if (!preview) return;
    setBusy('record');
    setServerError(null);
    try {
      if (preview.built.route === 'event') await api.recordEvent(projectId, preview.built.draft);
      else await api.recordPlanEdit(projectId, preview.built.draft);
      onRecorded(preview.built.summary);
    } catch (e) {
      setServerError(e);
    } finally {
      setBusy(null);
    }
  };

  const isPlan = template.route === 'plan-edit';
  const moduleNames = new Map(detail.modules.map((m) => [m.id, m.name]));
  const taskNames = new Map(ctx.tasks.map((t) => [t.id, t.name]));

  return (
    <Card
      title={template.title}
      sub={isPlan ? 'A planning change: it moves the plan as well as the forecast, so it is not counted as delay.' : 'An event: something that happened to work that has started. It counts as delay if it pushes delivery out.'}
      actions={
        <button type="button" className="button small quiet" onClick={onCancel}>
          Cancel
        </button>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void doPreview();
        }}
      >
        <div className="form-grid">
          {template.fields.map((f) => (
            <FieldInput key={f.id} field={f} id={`${id}-${f.id}`} value={values[f.id] ?? ''} ctx={ctx} onChange={(v) => setValue(f.id, v)} />
          ))}
        </div>

        <div className="form-grid">
          <div className="field">
            <label htmlFor={`${id}-when`}>{isPlan ? 'Effective from (status date)' : 'When did this happen?'}</label>
            <input id={`${id}-when`} type="date" value={common.when} onChange={(e) => setCommonField('when', e.target.value)} />
            <span className="help">The forecast is re-worked as of the end of this day.</span>
          </div>
          {template.asksPhase ? (
            <div className="field">
              <label htmlFor={`${id}-phase`}>Where was the project when this came up?</label>
              <select id={`${id}-phase`} value={common.phase} onChange={(e) => setCommonField('phase', e.target.value as Common['phase'])}>
                {phaseOptions(ctx.phases).map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className="help">Feeds the retrospective: late discoveries are the expensive ones.</span>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor={`${id}-by`}>Recorded by</label>
            <input id={`${id}-by`} type="text" value={common.createdBy} onChange={(e) => setCommonField('createdBy', e.target.value)} />
          </div>
        </div>

        <div className="form-grid">
          <div className="field">
            <label htmlFor={`${id}-title`}>Title (optional)</label>
            <input id={`${id}-title`} type="text" value={common.title} placeholder="Leave empty to use a summary" onChange={(e) => setCommonField('title', e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-notes`}>{isPlan ? 'Reason (optional)' : 'Notes (optional)'}</label>
            <textarea id={`${id}-notes`} value={common.description} onChange={(e) => setCommonField('description', e.target.value)} />
          </div>
        </div>

        {!isPlan ? (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={common.couldHaveBeenEarlier} onChange={(e) => setCommonField('couldHaveBeenEarlier', e.target.checked)} />
            This could have been identified earlier
          </label>
        ) : null}

        {problems.length > 0 ? (
          <div className="notice" role="alert">
            <StatusIcon health="warning" />
            <ul className="problems">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {serverError ? <ErrorNote error={serverError} /> : null}

        <div className="form-actions">
          <button type="submit" className="button" disabled={busy !== null}>
            {busy === 'preview' ? 'Working it out…' : preview ? 'Preview again' : 'Preview the effect'}
          </button>
          {preview ? (
            <button type="button" className="button primary" disabled={busy !== null} onClick={() => void doRecord()}>
              {busy === 'record' ? 'Recording…' : isPlan ? 'Record this planning change' : 'Record this event'}
            </button>
          ) : (
            <span className="muted">Nothing is written until you record it.</span>
          )}
        </div>
      </form>

      {preview ? (
        <div style={{ marginTop: 16 }}>
          <Preview built={preview.built} explanation={preview.explanation} moduleNames={moduleNames} taskNames={taskNames} />
        </div>
      ) : null}
    </Card>
  );
}

function Preview({ built, explanation, moduleNames, taskNames }: { built: Extract<Built, { ok: true }>; explanation: ChangeExplanation; moduleNames: ReadonlyMap<string, string>; taskNames: ReadonlyMap<string, string> }) {
  return (
    <div>
      <p className="secondary" style={{ marginBottom: 8 }}>
        If you record this, on {formatDate(built.draft.asOf, { year: true })}:
      </p>
      <div style={{ border: '1px dashed var(--axis)', borderRadius: 12 }}>
        <ChangeDetail explanation={explanation} entry={{ title: built.summary, kind: built.route === 'event' ? 'EVENT' : 'PLAN' }} moduleNames={moduleNames} taskNames={taskNames} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

function FieldInput({ field, id, value, ctx, onChange }: { field: Field; id: string; value: string | string[]; ctx: FormContext; onChange: (v: string | string[]) => void }) {
  const text = Array.isArray(value) ? (value[0] ?? '') : value;
  const label = (
    <label htmlFor={id}>
      {field.label}
      {field.required ? <span className="muted"> *</span> : null}
    </label>
  );
  const help = field.help ? <span className="help">{field.help}</span> : null;

  let control: ReactNode;
  switch (field.kind) {
    case 'task': {
      const tasks = tasksFor(field.scope ?? 'open', ctx);
      const byModule = new Map<string, typeof tasks>();
      for (const t of tasks) byModule.set(t.moduleId, [...(byModule.get(t.moduleId) ?? []), t]);
      control = (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a task…</option>
          {[...byModule.entries()].map(([moduleId, list]) => (
            <optgroup key={moduleId} label={ctx.modules.find((m) => m.id === moduleId)?.name ?? moduleId}>
              {list.map((t) => (
                <option key={t.id} value={t.id}>
                  {taskName(ctx, t)}
                  {t.kind === 'MILESTONE' ? ' (milestone)' : ''} · {t.state === 'IN_PROGRESS' ? 'in progress' : 'not started'}, ends {formatDate(t.finishDate)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      );
      break;
    }
    case 'tasks': {
      const tasks = tasksFor(field.scope ?? 'any', ctx);
      const chosen = Array.isArray(value) ? value : [];
      control = (
        <div className="checks" role="group" aria-labelledby={`${id}-label`}>
          {tasks.map((t) => (
            <label key={t.id}>
              <input type="checkbox" checked={chosen.includes(t.id)} onChange={(e) => onChange(e.target.checked ? [...chosen, t.id] : chosen.filter((x) => x !== t.id))} />
              {taskName(ctx, t)}
            </label>
          ))}
        </div>
      );
      break;
    }
    case 'team':
      control = (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose a team…</option>
          {ctx.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      );
      break;
    case 'module':
      control = (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {modulesFor(field.moduleScope ?? 'started', ctx).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      );
      break;
    case 'feature':
      control = (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">No, just this</option>
          {ctx.features.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      );
      break;
    case 'choice':
      control = (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'number':
      control = (
        <div className="with-suffix">
          <input id={id} type="number" inputMode="decimal" value={text} {...(field.min !== undefined ? { min: field.min } : {})} step={field.step ?? 1} onChange={(e) => onChange(e.target.value)} />
          {field.suffix ? <span className="suffix">{field.suffix}</span> : null}
        </div>
      );
      break;
    case 'date':
      control = <input id={id} type="date" value={text} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'text':
      control = <input id={id} type="text" value={text} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
      break;
  }

  return (
    <div className="field">
      {field.kind === 'tasks' ? (
        <span className="label" id={`${id}-label`}>
          {field.label}
        </span>
      ) : (
        label
      )}
      {control}
      {help}
    </div>
  );
}
