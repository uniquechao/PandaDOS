import { useEffect, useState } from 'preact/hooks';
import type { LocalPlansView as PlansData } from '../../../shared/local-plans';
import { api } from '../lib/api';
import { useI18n } from '../i18n/provider';
import { nav } from '../lib/router';

export function LocalPlansButton({ pid }: { pid: number }) {
  const i18n = useI18n();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const data = await api<PlansData>(`/api/projects/${pid}/local-plans`);
        if (active) setCount(data.candidates.filter(item => item.plan && !item.error && !item.execution).length);
      } catch { /* The plan page exposes discovery errors without disrupting the issue board. */ }
      finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [pid]);
  return <button class="btn sm wb-list-action" title={i18n.t('localPlans.title')} aria-label={i18n.t('localPlans.title')} onClick={() => nav(`/p/${pid}/local-plans`)}>
    <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 4H5v17h14V4h-3M8 3h8v4H8zM8 12h8M8 16h5" /></svg>
    {count > 0 && <span class="badge b-amber">{i18n.formatNumber(count)}</span>}
  </button>;
}

export { LocalPlansWorkspace as LocalPlansView } from './LocalPlansWorkspace';
