import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, ApiError, getProjectExecutorAgents } from '../lib/api';
import {
  designCreateFingerprint,
  groupDesignTasks,
  LatestOnlyRequestGuard,
  mergeLatestDesignTasks,
  preferLatestDesignTask,
  resolveDesignSelection,
  type DesignCreateInput,
  type DesignTask,
  type DesignTaskStage,
} from '../lib/design';
import type { AgentKind, Me, Project, ProjectModule } from '../lib/types';
import { timeAgo } from '../lib/fmt';
import { nav } from '../lib/router';
import { useContainerWide } from '../lib/useContainerWide';
import { Modal } from '../components/Modal';
import { Loading } from '../components/Loaders';
import { toast } from '../lib/toast';
import { useI18n } from '../i18n/provider';
import type { MessageKey } from '../../../shared/i18n/messages';
import { DesignWorkbench } from './DesignWorkbench';

const STAGE_KEYS: Record<DesignTaskStage, MessageKey> = {
  goal_setting: 'design.stage.goal_setting',
  solution_draft: 'design.stage.solution_draft',
  review: 'design.stage.review',
  graph_draft: 'design.stage.graph_draft',
  approved: 'design.stage.approved',
  executing: 'design.stage.executing',
  completed: 'design.stage.completed',
  archived: 'design.stage.archived',
  error: 'design.stage.error',
};

function DesignAgentLogo({ kind }: { kind: AgentKind }) {
  return (
    <span class={`design-agent-logo ${kind}`} aria-hidden="true">
      {kind === 'claude' ? (
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3 6.3 17.7" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" focusable="false">
          <rect x="7.4" y="3.4" width="9.2" height="17.2" rx="4.6" />
          <rect x="7.4" y="3.4" width="9.2" height="17.2" rx="4.6" transform="rotate(60 12 12)" />
          <rect x="7.4" y="3.4" width="9.2" height="17.2" rx="4.6" transform="rotate(120 12 12)" />
        </svg>
      )}
    </span>
  );
}

function DesignScopeIcon({ module }: { module: boolean }) {
  return (
    <svg class="design-scope-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {module ? (
        <>
          <path d="m12 3.7 7.2 4.1v8.4L12 20.3l-7.2-4.1V7.8L12 3.7Z" />
          <path d="m4.8 7.8 7.2 4.1 7.2-4.1M12 11.9v8.4" />
        </>
      ) : (
        <path d="M3.5 7.5h6l1.8 2h9.2v8.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V7.5Zm0 2h17M5.2 7.5V5.8c0-.7.6-1.3 1.3-1.3h4.1l1.8 2h6.1c.7 0 1.3.6 1.3 1.3v1.7" />
      )}
    </svg>
  );
}

function DesignScopeSelect({
  modules,
  value,
  fieldLabel,
  projectLabel,
  onChange,
}: {
  modules: ProjectModule[];
  value: number | null;
  fieldLabel: string;
  projectLabel: string;
  onChange: (value: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const options = [{ id: null, label: projectLabel }, ...modules.map((module) => ({ id: module.id, label: module.displayName }))];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));
  const selected = options[selectedIndex]!;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, selectedIndex]);

  const pick = (nextValue: number | null): void => {
    onChange(nextValue);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const moveFocus = (direction: -1 | 1): void => {
    if (!open) {
      setOpen(true);
      return;
    }
    const current = optionRefs.current.indexOf(document.activeElement as HTMLButtonElement);
    const start = current < 0 ? selectedIndex : current;
    optionRefs.current[(start + direction + options.length) % options.length]?.focus();
  };

  return (
    <div
      class="design-scope-select"
      ref={wrapRef}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(event.key === 'ArrowDown' ? 1 : -1);
        } else if (open && event.key === 'Home') {
          event.preventDefault();
          optionRefs.current[0]?.focus();
        } else if (open && event.key === 'End') {
          event.preventDefault();
          optionRefs.current[options.length - 1]?.focus();
        } else if (open && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        type="button"
        class="design-scope-control"
        ref={triggerRef}
        aria-label={fieldLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span class="design-scope-mark"><DesignScopeIcon module={selected.id !== null} /></span>
        <span class="design-scope-current">{selected.label}</span>
        <svg class={`design-scope-chevron${open ? ' open' : ''}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div class="design-scope-menu" role="listbox" aria-label={fieldLabel}>
          {options.map((option, index) => (
            <button
              type="button"
              role="option"
              aria-selected={option.id === value}
              class={`design-scope-option${option.id === value ? ' selected' : ''}`}
              key={option.id ?? 'project'}
              ref={(element) => { optionRefs.current[index] = element; }}
              onClick={() => pick(option.id)}
            >
              <span class="design-scope-mark"><DesignScopeIcon module={option.id !== null} /></span>
              <span>{option.label}</span>
              <svg class="design-scope-check" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m3.5 8.2 2.8 2.8 6.2-6.2" />
              </svg>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function DesignCreateModal({
  pid,
  modules,
  supportedAgents,
  onClose,
  onCreated,
}: {
  pid: number;
  modules: ProjectModule[];
  supportedAgents: AgentKind[];
  onClose: () => void;
  onCreated: (task: DesignTask) => void;
}) {
  const { t } = useI18n();
  const activeModules = modules.filter((module) => module.status === 'active');
  const [title, setTitle] = useState('');
  const [originalRequest, setOriginalRequest] = useState('');
  const [moduleId, setModuleId] = useState<number | null>(null);
  const [agent, setAgent] = useState<AgentKind>(supportedAgents[0] ?? 'claude');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    if (!supportedAgents.includes(agent) && supportedAgents[0]) setAgent(supportedAgents[0]);
  }, [supportedAgents.join(',')]);

  const chooseModule = (nextId: number | null): void => {
    setModuleId(nextId);
    const selected = activeModules.find((module) => module.id === nextId);
    if (selected) setAgent(selected.agent);
  };

  const submit = async (event: Event): Promise<void> => {
    event.preventDefault();
    if (!title.trim() || !originalRequest.trim() || saving) return;
    const input: DesignCreateInput = { title: title.trim(), originalRequest, moduleId, agent };
    const fingerprint = designCreateFingerprint(input);
    if (requestRef.current?.fingerprint !== fingerprint) {
      requestRef.current = { fingerprint, key: crypto.randomUUID() };
    }
    setSaving(true);
    setError('');
    try {
      const result = await api<{ ok: true; design: DesignTask }>(
        `/api/projects/${pid}/designs`,
        'POST',
        input,
        { idempotencyKey: requestRef.current.key },
      );
      requestRef.current = null;
      onCreated(result.design);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : t('design.loadFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={t('design.createTitle')} onClose={onClose}>
      <form class="design-create-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>{t('design.titleField')}</span>
          <input value={title} onInput={(event) => setTitle(event.currentTarget.value)} placeholder={t('design.titlePlaceholder')} required />
        </label>
        <label>
          <span>{t('design.needField')}</span>
          <textarea value={originalRequest} onInput={(event) => setOriginalRequest(event.currentTarget.value)} placeholder={t('design.needPlaceholder')} required />
          <small>{t('design.needHelp')}</small>
        </label>
        <fieldset class="design-scope-field">
          <legend>{t('design.moduleField')}</legend>
          <DesignScopeSelect
            modules={activeModules}
            value={moduleId}
            fieldLabel={t('design.moduleField')}
            projectLabel={t('design.projectLevel')}
            onChange={chooseModule}
          />
        </fieldset>
        <fieldset>
          <legend>{t('design.agentField')}</legend>
          <div class="design-agent-options">
            {(['claude', 'codex'] as const).map((kind) => {
              const optionDisabled = !supportedAgents.includes(kind) || moduleId !== null;
              return (
                <label
                  class={`design-agent-option${agent === kind ? ' selected' : ''}${optionDisabled ? ' disabled' : ''}`}
                  key={kind}
                >
                  <DesignAgentLogo kind={kind} />
                  <span class="design-agent-name">{kind === 'claude' ? 'Claude Code' : 'Codex'}</span>
                  <input
                    type="radio"
                    name="design-agent"
                    value={kind}
                    checked={agent === kind}
                    disabled={optionDisabled}
                    onChange={() => setAgent(kind)}
                  />
                </label>
              );
            })}
          </div>
        </fieldset>
        {error && <div class="err" role="alert">{error}</div>}
        <div class="form-actions">
          <button type="button" class="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" class="btn primary" disabled={saving || !title.trim() || !originalRequest.trim() || !supportedAgents.includes(agent)}>
            {saving ? t('design.creating') : t('design.create')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DesignTaskList({
  tasks,
  selectedId,
  modules,
  canCreate,
  onCreate,
  onOpen,
}: {
  tasks: DesignTask[] | null;
  selectedId: number | null;
  modules: ProjectModule[];
  canCreate: boolean;
  onCreate: () => void;
  onOpen: (id: number) => void;
}) {
  const { t } = useI18n();
  const groups = groupDesignTasks(tasks ?? []);
  const moduleById = new Map(modules.map((module) => [module.id, module.displayName]));
  const sections: { key: keyof typeof groups; label: MessageKey }[] = [
    { key: 'active', label: 'design.groupActive' },
    { key: 'graph', label: 'design.groupGraph' },
    { key: 'closed', label: 'design.groupClosed' },
  ];
  return (
    <aside class="design-task-rail" aria-label={t('design.taskCount', { count: tasks?.length ?? 0 })}>
      <div class="design-rail-head">
        <div>
          <span class="design-eyebrow">{t('design.title')}</span>
          <strong>{t('design.taskCount', { count: tasks?.length ?? 0 })}</strong>
        </div>
        <button class="btn sm primary" disabled={!canCreate} title={!canCreate ? t('design.ownerOnly') : undefined} onClick={onCreate}>＋ {t('design.new')}</button>
      </div>
      <div class="design-rail-scroll">
        {tasks === null ? <Loading /> : tasks.length === 0 ? <div class="design-rail-empty">{t('design.empty')}</div> : sections.map((section) => {
          const rows = groups[section.key];
          if (rows.length === 0) return null;
          const taskRows = rows.map((task) => {
            const active = task.id === selectedId;
            return (
              <button key={task.id} class={active ? 'design-task-row on' : 'design-task-row'} aria-current={active ? 'page' : undefined} onClick={() => onOpen(task.id)}>
                <span class="design-task-title">{task.title}</span>
                <span class="design-task-meta">
                  <span class={`design-stage ${task.status === 'error' ? 'error' : ''}`}>{t(STAGE_KEYS[task.stage])}</span>
                  <span>{task.moduleId ? moduleById.get(task.moduleId) ?? t('design.projectLevel') : t('design.projectLevel')}</span>
                </span>
                <span class="design-task-time">{t('design.updated', { time: timeAgo(task.updatedTs) })}</span>
              </button>
            );
          });
          if (section.key === 'closed') {
            return (
              <details class="design-rail-group" key={section.key} open={rows.some((task) => task.id === selectedId)}>
                <summary class="design-rail-group-head">
                  <span>{t(section.label)}</span>
                  <span>{rows.length}</span>
                </summary>
                {taskRows}
              </details>
            );
          }
          return (
            <section class="design-rail-group" key={section.key}>
              <div class="design-rail-group-head">
                <span>{t(section.label)}</span>
                <span>{rows.length}</span>
              </div>
              {taskRows}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

export function DesignsView({ pid, selDid, me }: { pid: number; selDid?: number; me: Me }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const wide = useContainerWide(rootRef);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<DesignTask[] | null>(null);
  const [modules, setModules] = useState<ProjectModule[]>([]);
  const [supportedAgents, setSupportedAgents] = useState<AgentKind[]>([]);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const listGuardRef = useRef(new LatestOnlyRequestGuard());
  const refreshListRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    const scope = new AbortController();
    setProject(null);
    setTasks(null);
    setModules([]);
    setSupportedAgents([]);
    setError('');

    const refreshList = (initial = false): void => {
      const ticket = listGuardRef.current.begin();
      api<{ ok: true; designs: DesignTask[] }>(
        `/api/projects/${pid}/designs`,
        'GET',
        undefined,
        { signal: ticket.signal },
      ).then((result) => {
        if (!active || !listGuardRef.current.isCurrent(ticket)) return;
        setTasks((current) => mergeLatestDesignTasks(current, result.designs));
      }).catch((cause) => {
        if (active && initial && listGuardRef.current.isCurrent(ticket)) {
          setError(cause instanceof ApiError ? cause.message : t('design.loadFailed'));
        }
      });
    };
    refreshListRef.current = () => refreshList(false);

    Promise.all([
      api<Project>(`/api/projects/${pid}`, 'GET', undefined, { signal: scope.signal }),
      api<{ modules: ProjectModule[] }>(`/api/projects/${pid}/modules`, 'GET', undefined, { signal: scope.signal }),
    ]).then(([projectResult, moduleResult]) => {
      if (!active) return;
      setProject(projectResult);
      setModules(moduleResult.modules);
    }).catch((cause) => {
      if (active && !scope.signal.aborted) {
        setError(cause instanceof ApiError ? cause.message : t('design.loadFailed'));
      }
    });
    void getProjectExecutorAgents(pid, scope.signal)
      .then((agents) => { if (active) setSupportedAgents(agents); })
      .catch(() => { if (active && !scope.signal.aborted) setSupportedAgents([]); });

    refreshList(true);
    const timer = window.setInterval(() => refreshList(false), 5_000);
    return () => {
      active = false;
      scope.abort();
      window.clearInterval(timer);
      listGuardRef.current.invalidate();
      refreshListRef.current = null;
    };
  }, [pid]);

  const selection = useMemo(
    () => resolveDesignSelection({ requestedId: selDid, tasks, wide }),
    [selDid, tasks, wide],
  );
  const selected = tasks?.find((task) => task.id === selection.selectedId) ?? null;
  const canManage = !!project && (me.role === 'admin' || project.ownerUserId === me.id);

  useEffect(() => {
    if (!selection.shouldReplaceRoute) return;
    nav(selection.selectedId === null ? `/p/${pid}/designs` : `/p/${pid}/designs/${selection.selectedId}`, { replace: true });
  }, [selection.shouldReplaceRoute, selection.selectedId, pid]);

  const updateTask = (next: DesignTask): void => {
    setTasks((current) => current?.map((task) => (
      task.id === next.id ? preferLatestDesignTask(task, next) : task
    )) ?? current);
  };

  const confirmGoal = async (): Promise<void> => {
    if (!selected || confirming || !canManage) return;
    setConfirming(true);
    try {
      const result = await api<{ ok: true; design: DesignTask }>(
        `/api/projects/${pid}/designs/${selected.id}/confirm-goal`,
        'POST',
        { expectedRevision: selected.currentRevision },
      );
      listGuardRef.current.invalidate();
      updateTask(result.design);
      refreshListRef.current?.();
      toast.success(t('design.goalConfirmed'));
    } catch (cause) {
      toast.error(cause instanceof ApiError ? cause.message : t('design.loadFailed'));
    } finally {
      setConfirming(false);
    }
  };

  const headerAction = selected?.stage === 'goal_setting' ? (
    <button class="btn primary" disabled={!canManage || confirming} onClick={() => void confirmGoal()}>
      {confirming ? t('design.confirmingGoal') : t('design.confirmGoal')}
    </button>
  ) : selected?.stage === 'solution_draft' ? <span class="design-agent-working">{t('design.agentWorking')}</span> : null;

  const list = (
    <DesignTaskList
      tasks={tasks}
      selectedId={selection.selectedId}
      modules={modules}
      canCreate={canManage}
      onCreate={() => setCreating(true)}
      onOpen={(id) => nav(`/p/${pid}/designs/${id}`)}
    />
  );

  return (
    <div ref={rootRef} class="fullcol design-view">
      <header class="design-workspace-header">
        <div class="design-header-main">
          {!wide && selected && <button class="back" aria-label={t('design.back')} onClick={() => nav(`/p/${pid}/designs`)}>‹</button>}
          <div class="design-header-copy">
            <span class="design-breadcrumb">{project?.name ?? ''} / {t('design.title')}</span>
            <h1>{selected?.title ?? t('design.title')}</h1>
          </div>
        </div>
        {selected && (
          <div class="design-header-meta">
            <span class="design-stage">{t(STAGE_KEYS[selected.stage])}</span>
            <span>{t('design.revision', { revision: selected.currentRevision })}</span>
            <span>{selected.agent === 'claude' ? 'Claude Code' : 'Codex'}</span>
          </div>
        )}
        <div class="design-header-action">{headerAction}</div>
      </header>
      {error ? <div class="design-page-error" role="alert">{error}</div> : (
        <div class={wide ? 'design-workspace-body wide' : 'design-workspace-body narrow'}>
          {wide || !selected ? list : null}
          {selected && (
            <DesignWorkbench key={selected.id} pid={pid} did={selected.id} task={selected} wide={wide} canManage={canManage} onTask={updateTask} />
          )}
        </div>
      )}
      {creating && (
        <DesignCreateModal
          pid={pid}
          modules={modules}
          supportedAgents={supportedAgents}
          onClose={() => setCreating(false)}
          onCreated={(task) => {
            listGuardRef.current.invalidate();
            setTasks((current) => mergeLatestDesignTasks(current, [task]));
            refreshListRef.current?.();
            setCreating(false);
            nav(`/p/${pid}/designs/${task.id}`);
          }}
        />
      )}
    </div>
  );
}
