/**
 * 项目原生 Bash 页 —— 固定连接隔离的项目 console，不附着 issue/chat 代理。
 */
import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { nav } from '../lib/router';
import { TermPane, type TermStatus } from '../components/TermPane';
import type { Project } from '../lib/types';
import { useI18n } from '../i18n/provider';

export function TermView({ pid }: { pid: number }) {
  const { t } = useI18n();
  const [project, setProject] = useState<Project | null>(null);
  const [status, setStatus] = useState<TermStatus>('connecting');

  useEffect(() => {
    api<Project>(`/api/projects/${pid}`).then(setProject).catch(() => {});
  }, [pid]);

  return (
    <div class="fullcol">
      <div class="bhead" style={{ paddingBottom: 6 }}>
        <div class="bhead-row">
          <button class="back" onClick={() => nav(`/p/${pid}`)}>
            ‹
          </button>
          <span class="btitle">{project?.name ?? t('view.projectFallback', { id: pid })} · {t('view.nativeBash')}</span>
          <span class="mut small">
            {status === 'open' ? '🟢' : status === 'connecting' ? '…' : status === 'exit' ? t('view.ended') : t('ui.disconnected')}
          </span>
        </div>
      </div>
      <TermPane pid={pid} target={{ kind: 'bash' }} onStatus={setStatus} />
    </div>
  );
}
