import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { MessageKey } from '../../../shared/i18n/messages';
import { Loading } from '../components/Loaders';
import { tr } from '../i18n/runtime';
import { api } from '../lib/api';
import { fmtTime } from '../lib/fmt';
import { toast } from '../lib/toast';

interface FeishuMessagingStatus {
  enabled: boolean;
  configured: boolean;
  state: 'disabled' | 'unconfigured' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
  lastReceivedAt: number | null;
  lastSentAt: number | null;
  lastError: 'connection_failed' | 'send_failed' | null;
  bound: boolean;
}

type MessagingAction = 'save' | 'reconnect' | 'test';
const stateKeys: Record<FeishuMessagingStatus['state'], MessageKey> = {
  disabled: 'feishuMessaging.stateDisabled',
  unconfigured: 'feishuMessaging.stateUnconfigured',
  connecting: 'feishuMessaging.stateConnecting',
  connected: 'feishuMessaging.stateConnected',
  reconnecting: 'feishuMessaging.stateReconnecting',
  failed: 'feishuMessaging.stateFailed',
};
const actionErrorKeys: Record<MessagingAction, MessageKey> = {
  save: 'feishuMessaging.saveFailed',
  reconnect: 'feishuMessaging.reconnectFailed',
  test: 'feishuMessaging.testFailed',
};

export function FeishuMessagingSection({ credentialsRevision }: { credentialsRevision: number }) {
  const [status, setStatus] = useState<FeishuMessagingStatus | null>(null);
  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<MessagingAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<MessageKey | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refreshPending = useRef(false);

  const load = useCallback(async (visible = false): Promise<void> => {
    if (actionRequest.current) { refreshPending.current = true; return; }
    if (readRequest.current) return;
    const controller = new AbortController();
    readRequest.current = controller;
    if (visible) setLoading(true);
    try {
      const next = await api<FeishuMessagingStatus>('/api/admin/feishu-messaging', 'GET', undefined, { signal: controller.signal });
      if (mounted.current && !controller.signal.aborted) {
        setStatus(next);
        setLoadFailed(false);
      }
    } catch {
      if (mounted.current && !controller.signal.aborted) setLoadFailed(true);
    } finally {
      if (readRequest.current === controller) {
        readRequest.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readRequest.current?.abort();
      actionRequest.current?.abort();
    };
  }, []);
  useEffect(() => {
    // Saved credentials can change even while messaging is disabled.
    readRequest.current?.abort();
    readRequest.current = null;
    void load(true);
  }, [credentialsRevision, load]);
  useEffect(() => {
    if (!status?.enabled) return;
    const timer = setInterval(() => { void load(); }, 5_000);
    return () => clearInterval(timer);
  }, [status?.enabled, load]);

  const act = async (action: MessagingAction): Promise<void> => {
    if (actionRequest.current || !status) return;
    const enabled = draftEnabled ?? status.enabled;
    if (action === 'save' && enabled && !status.configured) return;
    if (action !== 'save' && (!status.enabled || !status.configured)) return;
    if (action === 'test' && !status.bound) return;
    readRequest.current?.abort();
    readRequest.current = null;
    const controller = new AbortController();
    actionRequest.current = controller;
    setLoading(false);
    setBusy(action);
    setActionError(null);
    try {
      if (action === 'test') {
        await api<{ ok: true }>('/api/admin/feishu-messaging/test', 'POST', undefined, { signal: controller.signal });
        if (mounted.current && !controller.signal.aborted) toast.success(tr('feishuMessaging.testSent'));
      } else {
        const next = action === 'save'
          ? await api<FeishuMessagingStatus>('/api/admin/feishu-messaging', 'PUT', { enabled }, { signal: controller.signal })
          : await api<FeishuMessagingStatus>('/api/admin/feishu-messaging/reconnect', 'POST', undefined, { signal: controller.signal });
        if (mounted.current && !controller.signal.aborted) {
          setStatus(next);
          if (action === 'save') {
            setDraftEnabled(null);
            toast.success(tr('feishuMessaging.saved'));
          }
        }
      }
    } catch {
      if (mounted.current && !controller.signal.aborted) setActionError(actionErrorKeys[action]);
    } finally {
      actionRequest.current = null;
      if (mounted.current) {
        setBusy(null);
        if (action === 'test' || refreshPending.current) {
          refreshPending.current = false;
          void load();
        }
      }
    }
  };

  const enabled = draftEnabled ?? status?.enabled ?? false;
  const locked = !!busy || loading;
  return <section class="sect llm-config feishu-login-config feishu-messaging" aria-busy={locked}>
    <div class="row feishu-login-heading">
      <div class="grow">
        <h2 class="h2">{tr('feishuMessaging.title')}</h2>
        <p class="mut small">{tr('feishuMessaging.help')}</p>
      </div>
      {status && <span class={`badge ${status.state === 'connected' ? 'b-green' : status.state === 'disabled' ? 'b-gray' : 'b-amber'}`} role="status">
        {tr(stateKeys[status.state])}
      </span>}
    </div>
    {!status && loading && <Loading />}
    {loadFailed && <div class="feishu-messaging-error">
      <p class="err" role="alert">{tr('feishuMessaging.loadFailed')}</p>
      <button class="btn" disabled={locked} onClick={() => void load(true)}>{tr('feishuLogin.retry')}</button>
    </div>}
    {status && <>
      <form onSubmit={(event) => { event.preventDefault(); void act('save'); }}>
        <fieldset class="feishu-login-fields" disabled={locked}>
          <label class="feishu-login-toggle">
            <input type="checkbox" checked={enabled} aria-describedby="feishu-messaging-switch-help"
              onChange={(event) => { setDraftEnabled(event.currentTarget.checked); setActionError(null); }} />
            <span>{tr('feishuMessaging.enabled')}</span>
          </label>
          <p id="feishu-messaging-switch-help" class="mut small">{tr('feishuMessaging.switchHelp')}</p>
          {!status.configured && <p class="feishu-messaging-hint">{tr('feishuMessaging.credentialsRequired')}</p>}
          {!status.enabled && <p class="mut small">{tr('feishuMessaging.disabledHelp')}</p>}
          <div class="row feishu-login-actions">
            <button class="btn" type="submit" disabled={locked || enabled === status.enabled || (enabled && !status.configured)}>
              {busy === 'save' ? tr('ui.saving') : tr('feishuMessaging.save')}
            </button>
          </div>
        </fieldset>
      </form>
      <dl class="feishu-messaging-status">
        <dt>{tr('feishuMessaging.lastReceived')}</dt>
        <dd>{status.lastReceivedAt === null ? tr('feishuMessaging.noActivity') : fmtTime(status.lastReceivedAt)}</dd>
        <dt>{tr('feishuMessaging.lastSent')}</dt>
        <dd>{status.lastSentAt === null ? tr('feishuMessaging.noActivity') : fmtTime(status.lastSentAt)}</dd>
        <dt>{tr('feishuMessaging.account')}</dt>
        <dd>{tr(status.bound ? 'feishuMessaging.accountBound' : 'feishuMessaging.accountUnbound')}</dd>
      </dl>
      {status.lastError && <p class="err" role="status">{tr(status.lastError === 'connection_failed' ? 'feishuMessaging.connectionFailed' : 'feishuMessaging.sendFailed')}</p>}
      {!status.bound && <p class="feishu-messaging-hint">{tr('feishuMessaging.bindingRequired')}</p>}
      <div class="row feishu-login-actions">
        <button class="btn" type="button" disabled={locked || !status.enabled || !status.configured} onClick={() => void act('reconnect')}>
          {tr(busy === 'reconnect' ? 'feishuMessaging.reconnecting' : 'feishuMessaging.reconnect')}
        </button>
        <button class="btn" type="button" disabled={locked || !status.enabled || !status.configured || !status.bound} onClick={() => void act('test')}>
          {tr(busy === 'test' ? 'feishuMessaging.sending' : 'feishuMessaging.test')}
        </button>
      </div>
      <p class="mut small">{tr('feishuMessaging.testHelp')}</p>
      {actionError && <p class="err" role="alert">{tr(actionError)}</p>}
    </>}
    <div class="feishu-login-setup">
      <h3 class="h2">{tr('feishuMessaging.setupTitle')}</h3>
      <ol class="feishu-messaging-checklist">
        <li>{tr('feishuMessaging.setupBot')}</li>
        <li>{tr('feishuMessaging.setupConnection')}</li>
        <li>{tr('feishuMessaging.setupEvent')}</li>
        <li>{tr('feishuMessaging.setupPermissions')}</li>
        <li>{tr('feishuMessaging.setupPublish')}</li>
      </ol>
      <p class="mut small">{tr('feishuMessaging.setupScope')}</p>
    </div>
    <div class="feishu-login-setup">
      <h3 class="h2">{tr('feishuMessaging.usageTitle')}</h3>
      <p>{tr('feishuMessaging.usage')}</p>
      <p class="mut small">{tr('feishuMessaging.accessHelp')}</p>
    </div>
  </section>;
}
