import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import { nav } from '../lib/router';
import { toast } from '../lib/toast';
import { useI18n } from '../i18n/provider';
import type { DesignPersonaView } from '../lib/design';

export function DesignPersonaPanel({ pid, personas, canManage, onRefresh }: {
  pid: number; personas: DesignPersonaView[]; canManage: boolean; onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [market, setMarket] = useState<DesignPersonaView[]>([]);
  const [busy, setBusy] = useState('');
  useEffect(() => { let active = true; const controller = new AbortController(); void api<{ personas: DesignPersonaView[] }>(`/api/projects/${pid}/personas/market`, 'GET', undefined, { signal: controller.signal }).then((result) => { if (active) setMarket(result.personas); }).catch(() => undefined); return () => { active = false; controller.abort(); }; }, [pid]);
  const act = async (name: string, operation: () => Promise<unknown>) => { if (busy) return; setBusy(name); try { await operation(); onRefresh(); toast.success(t('ui.saved')); } catch (error) { toast.error(error instanceof ApiError ? error.message : t('design.loadFailed')); } finally { setBusy(''); } };
  const grouped = (origin: DesignPersonaView['origin']) => personas.filter((item) => item.origin === origin);
  const card = (persona: DesignPersonaView) => <li class="design-persona-card" key={persona.key}><div><strong>{persona.manifest.displayName}</strong><span class="badge b-gray">{t(`design.personaOrigin.${persona.origin}`)}</span></div><p>{persona.manifest.reviewSpecialty}</p><div class="row"><span>{persona.approval}</span>{persona.enabled && <span class="badge b-green">{t('design.personaEnabled')}</span>}{canManage && persona.origin !== 'market' && <button class="btn" disabled={!!busy} onClick={() => void act(`persona-${persona.id}`, () => api(`/api/projects/${pid}/personas/${persona.id}`, 'PATCH', persona.approval === 'pending' || persona.approval === 'stale' ? { approveHash: persona.contentHash, enabled: true } : { enabled: !persona.enabled }))}>{persona.enabled ? t('design.personaDisable') : t('design.personaEnable')}</button>}{canManage && persona.origin === 'market' && <button class="btn" disabled={!!busy} onClick={() => void act(`publish-${persona.id}`, () => api(`/api/projects/${pid}/personas/publish`, 'POST', { key: persona.key, contentHash: persona.contentHash }))}>{t('design.personaPublish')}</button>}</div></li>;
  return <section class="design-personas"><div class="design-persona-head"><h4>{t('design.personas')}</h4>{canManage && <div class="row"><button class="btn" onClick={() => void act('discover', () => api(`/api/projects/${pid}/personas/discover`, 'POST', {}))}>{t('design.personaDiscover')}</button><button class="btn" onClick={() => nav('/admin')}>{t('design.personaMarketsAdmin')}</button></div>}</div>{(['builtin','project'] as const).map((origin) => <details open><summary>{t(`design.personaOrigin.${origin}`)} · {grouped(origin).length}</summary><ul>{grouped(origin).map(card)}</ul></details>)}<details><summary>{t('design.personaOrigin.market')} · {market.length}</summary><ul>{market.map(card)}</ul></details></section>;
}
