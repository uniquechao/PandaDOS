/**
 * 项目原生 Bash 页 —— 固定连接隔离的项目 console，不附着 issue/chat 代理。
 */
import { useEffect, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { nav } from '../lib/router';
import { TermPane, type TermStatus } from '../components/TermPane';
import type { Project } from '../lib/types';

export function TermView({ pid }: { pid: number }) {
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
          <span class="btitle">{project?.name ?? `项目 #${pid}`} · 原生 Bash</span>
          <span class="mut small">
            {status === 'open' ? '🟢' : status === 'connecting' ? '…' : status === 'exit' ? '已结束' : '已断开'}
          </span>
        </div>
      </div>
      <TermPane pid={pid} target={{ kind: 'bash' }} onStatus={setStatus} />
    </div>
  );
}
