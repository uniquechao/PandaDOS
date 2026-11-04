import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentModelCatalog, AgentModelState } from '../../../shared/agent-models';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../i18n/provider';
import { Modal } from './Modal';

export function AgentModelSettings({ pid, issueId, convId }: { pid: number; issueId?: string; convId?: string | null }) {
  const { t } = useI18n();
  const base = issueId ? `/api/projects/${pid}/issues/${issueId}` : convId ? `/api/projects/${pid}/conversations/${convId}` : null;
  const [open,setOpen]=useState(false);
  const [state,setState]=useState<AgentModelState | null>(null);
  const [catalog,setCatalog]=useState<AgentModelCatalog | null>(null);
  const [model,setModel]=useState('');
  const [effort,setEffort]=useState<string | null>(null);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [catalogError,setCatalogError]=useState<string | null>(null);
  const [stateError,setStateError]=useState<string | null>(null);
  const [saveError,setSaveError]=useState<string | null>(null);
  const stateRequest=useRef(0);
  const mutating=useRef(false);
  const errorCode=(error: unknown) => error instanceof ApiError ? error.code : 'model_operation_failed';
  const trigger=useRef<HTMLButtonElement>(null);
  const close=() => { setOpen(false);trigger.current?.focus(); };
  const epoch=useRef(0);
  const editing=useRef(false);
  useEffect(() => {
    epoch.current++; stateRequest.current++; editing.current=false;mutating.current=false;
    setOpen(false);setState(null);setCatalog(null);setModel('');setEffort(null);setCatalogError(null);setStateError(null);setSaveError(null);setLoading(false);setSaving(false);
  },[base]);
  const readState=async (active: () => boolean) => {
    if (!base || mutating.current) return;
    const request=++stateRequest.current;
    try {
      const next=await api<AgentModelState>(`${base}/model-settings`);
      if (!active() || request!==stateRequest.current) return;
      setState(next);setStateError(null);
      if (!editing.current) { setModel(next.selection?.model ?? '');setEffort(next.selection?.effort ?? null); }
    } catch (error) {
      if (active() && request===stateRequest.current) setStateError(errorCode(error));
    }
  };
  useEffect(() => {
    if (!base || !open) return;
    let active=true;
    void readState(() => active);
    const timer=setInterval(() => void readState(() => active),2_000);
    return () => { active=false;clearInterval(timer); };
  },[base,open]);
  const refresh=async () => {
    if (!base) return;
    const current=epoch.current;setLoading(true);
    const catalogRequest=async () => {
      try {
        const response=await api<{catalog:AgentModelCatalog}>(`${base}/model-options`);
        if (current===epoch.current) { setCatalog(response.catalog);setCatalogError(null); }
      } catch (error) {
        if (current===epoch.current) { setCatalog(null);setCatalogError(errorCode(error)); }
      }
    };
    try {
      await Promise.all([catalogRequest(),readState(() => current===epoch.current)]);
    } finally { if (current===epoch.current) setLoading(false); }
  };
  const save=async () => {
    if (!base || !state || !model || mutating.current) return;
    const current=epoch.current;setSaving(true);setSaveError(null);editing.current=true;
    mutating.current=true;stateRequest.current++;
    try {
      const result=await api<AgentModelState>(`${base}/model-settings`,'PATCH',{model,effort,revision:state.revision});
      if (current===epoch.current) { setState(result);setStateError(null);editing.current=false; }
    } catch (error) {
      if (current===epoch.current) {
        setSaveError(errorCode(error));
        // 保存冲突或响应丢失后重新读取版本，保留用户正在编辑的选择。
        mutating.current=false;
        await readState(() => current===epoch.current);
      }
    } finally { if (current===epoch.current) { mutating.current=false;setSaving(false); } }
  };
  const errors=[catalogError,stateError,saveError,state?.error].filter(Boolean);
  const option=catalog?.models.find(item => item.id===model);
  const valid=!!option && (effort===null || option.efforts.includes(effort));
  if (!base) return null;
  return <span class="agent-model-settings">
    <button ref={trigger} type="button" class="aa-btn" aria-haspopup="dialog" aria-expanded={open} onClick={() => {
      setOpen(true);
      if (!catalog && !loading) void refresh();
    }}>
      {t('models.settings')}<span class="aa-caret" aria-hidden="true">⌄</span>
    </button>
    {open && <Modal title={t('models.settings')} onClose={close}>
      <div class="agent-model-fields">
        <label><span>{t('models.model')}</span><select aria-label={t('models.model')} value={model} disabled={loading || saving || !catalog} onChange={event => {
          editing.current=true;const next=event.currentTarget.value;setModel(next);
          const item=catalog?.models.find(m => m.id===next);setEffort(item?.defaultEffort ?? item?.efforts[0] ?? null);
        }}>
          <option value="">{t('models.choose')}</option>
          {model && !option && <option value={model}>{model}</option>}
          {catalog?.models.map(m => <option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}
        </select></label>
        <label><span>{t('models.level')}</span><select aria-label={t('models.level')} value={effort ?? ''} disabled={loading || saving || !option?.efforts.length} onChange={event => { editing.current=true;setEffort(event.currentTarget.value || null); }}>
          <option value="">{t('models.default')}</option>
          {effort && !option?.efforts.includes(effort) && <option value={effort}>{effort}</option>}
          {option?.efforts.map(level => <option key={level} value={level}>{level}</option>)}
        </select></label>
        <div class="agent-model-status" role="status" aria-live="polite">
          {loading ? t('models.loading') : state ? t(`models.${state.state}`) : t('models.unset')}
          {!loading && catalog?.models.length===0 && <p>{t('models.empty')}</p>}
          {state?.actual && <p>{t('models.actual',{model:state.actual.model,effort:state.actual.effort ?? t('models.unknown')})}</p>}
        </div>
        {!!errors.length && <div class="agent-model-error" role="alert">{t('models.error')}<code>{[...new Set(errors)].join(' · ')}</code></div>}
      </div>
      <div class="agent-model-actions">
        <button type="button" class="btn ghost" disabled={loading || saving} onClick={() => void refresh()}>{t('models.refresh')}</button>
        <div class="agent-model-confirm">
          <button type="button" class="btn" onClick={close}>{t('models.close')}</button>
          <button type="button" class="btn primary" disabled={loading || saving || !valid || !state} onClick={() => void save()}>{t('models.save')}</button>
        </div>
      </div>
    </Modal>}
  </span>;
}
