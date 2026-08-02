/**
 * 技能页（v1 SkillsTab 平移 + v2 多用户语义）：
 * 子页「已装」：项目技能（可卸载）+ 全局技能（admin 可卸载）→ 点行看 SKILL.md；
 * 子页「市场」：多市场浏览（市场徽章/分类/搜索/只看推荐）+ 驱动大模型 翻译（NDJSON 流式，
 * 逐条实时上屏）+ 装到项目（属主）/ 装到全局（admin，落所有执行机）；
 * admin 另有「管理市场源」弹窗（增删源 + 单源同步）。
 */
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { timeAgo } from '../lib/fmt';
import { nav } from '../lib/router';
import type {
  MarketSkill,
  MarketSkillsList,
  MarketSyncResult,
  Me,
  Project,
  SkillInfo,
  SkillMarketInfo,
  SkillsList,
} from '../lib/types';
import { Loading } from '../components/Loaders';
import { Modal } from '../components/Modal';
import { toast } from '../lib/toast';
import { runtimeI18n, tr } from '../i18n/runtime';

// ---------- 极简 markdown 渲染（v1 SkillMD 平移；全部走文本节点，无 innerHTML） ----------

function inline(text: string): (string | JSX.Element)[] {
  // 切 `code` / **bold** / *italic* / [t](url)
  const out: (string | JSX.Element)[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((?:https?:\/\/)[^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const s = m[0];
    if (s.startsWith('`')) out.push(<code key={k++}>{s.slice(1, -1)}</code>);
    else if (s.startsWith('**')) out.push(<strong key={k++}>{s.slice(2, -2)}</strong>);
    else if (s.startsWith('*')) out.push(<em key={k++}>{s.slice(1, -1)}</em>);
    else {
      const mm = s.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (mm)
        out.push(
          <a key={k++} href={mm[2]} target="_blank" rel="noopener noreferrer">
            {mm[1]}
          </a>,
        );
      else out.push(s);
    }
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function SkillMD({ text }: { text: string }) {
  const blocks: JSX.Element[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  let k = 0;
  // 跳过 frontmatter
  if (lines[0]?.trim() === '---') {
    let j = 1;
    while (j < lines.length && lines[j]!.trim() !== '---') j++;
    i = j + 1;
  }
  while (i < lines.length) {
    const ln = lines[i]!;
    if (ln.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) buf.push(lines[i++]!);
      i++;
      blocks.push(
        <pre key={k++}>
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const h = ln.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const t = inline(h[2]!);
      blocks.push(h[1]!.length === 1 ? <h1 key={k++}>{t}</h1> : h[1]!.length === 2 ? <h2 key={k++}>{t}</h2> : <h3 key={k++}>{t}</h3>);
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(ln)) {
      const items: JSX.Element[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i]!)) {
        items.push(<li key={items.length}>{inline(lines[i]!.replace(/^\s*[-*+]\s+/, ''))}</li>);
        i++;
      }
      blocks.push(<ul key={k++}>{items}</ul>);
      continue;
    }
    if (ln.trim() === '') {
      i++;
      continue;
    }
    const buf: string[] = [ln];
    i++;
    while (i < lines.length && lines[i]!.trim() !== '' && !/^(#{1,3})\s|^```|^\s*[-*+]\s/.test(lines[i]!)) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push(<p key={k++}>{inline(buf.join(' '))}</p>);
  }
  return <div class="skmd">{blocks}</div>;
}

// ---------- 已装技能行 ----------

function SkillRow({
  s,
  onView,
  onRemove,
}: {
  s: SkillInfo;
  onView: () => void;
  onRemove?: (() => void) | undefined;
}) {
  return (
    <div class="skrow" onClick={onView}>
      <div class="skrow-hd">
        <span class="skrow-nm">{s.name}</span>
        {s.source && <span class="skbadge">{s.source === '内置' ? tr('skills.builtIn') : s.source}</span>}
        <span class="skrow-time">{timeAgo(s.mtimeMs)}</span>
      </div>
      {s.summary && <div class="skrow-sum">{s.summary}</div>}
      {onRemove && (
        <button
          class="linkbtn skrow-rm"
          title={tr('skills.uninstall')}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          {tr('skills.uninstall')}
        </button>
      )}
    </div>
  );
}

// ---------- 市场源管理弹窗（admin） ----------

function MarketAdmin({
  markets,
  onClose,
  onChanged,
}: {
  markets: SkillMarketInfo[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [subdir, setSubdir] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async (): Promise<void> => {
    setBusy(true);
    try {
      await api('/api/admin/skill-markets', 'POST', { name, repo, subdir, note });
      toast.success(tr('skills.addedSyncing'));
      setName('');
      setRepo('');
      setSubdir('');
      setNote('');
      onChanged();
      await api<MarketSyncResult>('/api/market/sync', 'POST', { name });
      onChanged();
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const del = async (n: string): Promise<void> => {
    if (!confirm(tr('skills.deleteSourceConfirm', { name: n }))) return;
    try {
      await api(`/api/admin/skill-markets/${encodeURIComponent(n)}`, 'DELETE');
      toast.success(tr('skills.deleted'));
      onChanged();
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  return (
    <Modal title={tr('skills.manageSources')} onClose={onClose}>
      <div class="mktadm">
        {markets.map((m) => (
          <div key={m.name} class="mktadm-row">
            <div class="mktadm-main">
              <b>{m.name}</b> <span class="mut small">{tr('skills.skillCount', { count: m.count })}</span>
              <div class="mut small">{m.repo}{m.subdir ? ` · ${m.subdir}` : ''}</div>
              {m.lastError && <div class="err small">{tr('skills.syncFailed', { error: m.lastError.slice(0, 120) })}</div>}
              {m.lastSyncTs && !m.lastError && (
                <div class="mut small">{tr('skills.lastSync', { time: timeAgo(m.lastSyncTs) })}</div>
              )}
            </div>
            <button class="linkbtn" onClick={() => void del(m.name)}>
              {tr('ui.delete')}
            </button>
          </div>
        ))}
        <div class="mktadm-add">
          <input placeholder={tr('skills.sourceNamePlaceholder')} value={name} onInput={(e) => setName(e.currentTarget.value)} />
          <input placeholder={tr('skills.repoPlaceholder')} value={repo} onInput={(e) => setRepo(e.currentTarget.value)} />
          <input placeholder={tr('skills.subdirPlaceholder')} value={subdir} onInput={(e) => setSubdir(e.currentTarget.value)} />
          <input placeholder={tr('skills.notePlaceholder')} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
          <button class="btn sm primary" disabled={busy || !name || !repo} onClick={() => void add()}>
            {busy ? tr('skills.adding') : `＋ ${tr('skills.addAndSync')}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- 市场 ----------

type InstallState = { busy?: boolean; ok?: string; err?: string };

function Market({
  pid,
  isAdmin,
  installedNames,
  onInstalled,
}: {
  pid: number;
  isAdmin: boolean;
  /** name → 'project' | 'global'（已装徽章） */
  installedNames: Map<string, 'project' | 'global'>;
  onInstalled: () => void;
}) {
  const [data, setData] = useState<MarketSkillsList | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [recOnly, setRecOnly] = useState(false);
  const [mktFilter, setMktFilter] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [inst, setInst] = useState<Record<string, InstallState>>({});
  const [adminOpen, setAdminOpen] = useState(false);
  const [view, setView] = useState<{ title: string; content: string } | null>(null);
  const autoTried = useRef(false);
  const enriching = useRef(false);

  const load = (): Promise<MarketSkillsList | null> =>
    api<MarketSkillsList>('/api/market/skills')
      .then((d) => {
        setData(d);
        return d;
      })
      .catch((e) => {
        setErr(String((e as Error).message));
        return null;
      });

  /** 驱动大模型 翻译（NDJSON 流式）：逐条 JSON 行，item 实时并入列表 */
  const enrich = async (force: boolean): Promise<void> => {
    if (enriching.current) return;
    enriching.current = true;
    setProg({ done: 0, total: 0 });
    try {
      const res = await fetch(`/api/market/enrich${force ? '?force=1' : ''}`, { method: 'POST' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      let done = 0;
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line) as
            | { type: 'meta'; total: number; todo: number }
            | { type: 'item'; skill: MarketSkill }
            | { type: 'item-error'; key: string }
            | { type: 'done'; enriched: number }
            | { type: 'error'; error: string };
          if (ev.type === 'meta') setProg({ done: 0, total: ev.todo });
          else if (ev.type === 'item') {
            done++;
            setProg((p) => (p ? { ...p, done } : p));
            setData((prev) =>
              prev
                ? { ...prev, skills: prev.skills.map((s) => (s.key === ev.skill.key ? ev.skill : s)) }
                : prev,
            );
          } else if (ev.type === 'item-error') done++;
          else if (ev.type === 'error') toast.error(ev.error);
        }
      }
    } catch (e) {
      toast.error(tr('skills.translationInterrupted', { error: String((e as Error).message) }));
    } finally {
      enriching.current = false;
      setProg(null);
    }
  };

  const sync = async (): Promise<void> => {
    setSyncing(true);
    try {
      const r = await api<MarketSyncResult>('/api/market/sync', 'POST', {});
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length) toast.error(tr('skills.someMarketsFailed', { names: runtimeI18n().formatList(bad.map((b) => b.name)) }), 6000);
      else toast.success(tr('skills.marketSynced'));
      const d = await load();
      // 同步完自动补翻译（量大时不自动，等用户点）
      if (d && d.skills.some((s) => !s.descZh && s.description)) void enrich(false);
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => {
    void load().then((d) => {
      if (!d || autoTried.current) return;
      autoTried.current = true;
      const untranslated = d.skills.filter((s) => !s.descZh && s.description).length;
      // v1 语义：首次打开自动翻译；量大（>120）时不自动烧 token，等用户点按钮
      if (untranslated > 0 && untranslated <= 120) void enrich(false);
    });
  }, []);

  const install = async (s: MarketSkill, scope: 'project' | 'global'): Promise<void> => {
    setInst((p) => ({ ...p, [s.key]: { busy: true } }));
    try {
      if (scope === 'project') {
        await api(`/api/projects/${pid}/skills/install`, 'POST', { market: s.market, rel: s.rel });
        setInst((p) => ({ ...p, [s.key]: { ok: `✅ ${tr('skills.installedProject')}` } }));
      } else {
        const r = await api<{ ok: boolean; results: { executor: string; ok: boolean; error?: string }[] }>(
          '/api/admin/skills/install-global',
          'POST',
          { market: s.market, rel: s.rel },
        );
        const bad = r.results.filter((x) => !x.ok);
        setInst((p) => ({
          ...p,
          [s.key]: bad.length
            ? { err: tr('skills.someFailed', { names: runtimeI18n().formatList(bad.map((b) => b.executor)) }) }
            : { ok: `✅ ${tr('skills.installedGlobal')}` },
        }));
      }
      onInstalled();
    } catch (e) {
      setInst((p) => ({ ...p, [s.key]: { err: String((e as Error).message).slice(0, 80) } }));
    }
  };

  const preview = async (s: MarketSkill): Promise<void> => {
    try {
      const r = await api<{ ok: boolean; content: string }>(
        `/api/market/skills/file?market=${encodeURIComponent(s.market)}&rel=${encodeURIComponent(s.rel)}`,
      );
      setView({ title: `${s.title} (${s.market})`, content: r.content });
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const list = data.skills.filter((s) => {
      if (mktFilter && s.market !== mktFilter) return false;
      if (recOnly && !s.recommend) return false;
      if (!needle) return true;
      return [s.name, s.title, s.market, s.category, s.description, s.descZh ?? '', s.reason ?? '', ...(s.tags ?? [])]
        .join('\n')
        .toLowerCase()
        .includes(needle);
    });
    // 推荐优先（稳定排序）
    return list.sort((a, b) => (b.recommend ? 1 : 0) - (a.recommend ? 1 : 0));
  }, [data, q, recOnly, mktFilter]);

  if (err) return <div class="err">{err}</div>;
  if (!data) return <Loading />;

  const untranslated = data.skills.filter((s) => !s.descZh && s.description).length;

  return (
    <div class="mkt">
      <div class="mkt-bar">
        <span class="mut small">
          {tr('skills.marketStats', { active: data.markets.filter((m) => m.count > 0).length, total: data.markets.length, skills: data.skills.length })}
        </span>
        {prog && (
          <span class="mkt-prog">
            {tr('skills.translatingProgress', { done: prog.done, total: prog.total })}
          </span>
        )}
        {!prog && untranslated > 0 && (
          <button class="btn sm" onClick={() => void enrich(false)}>
            🌐 {tr('skills.translateCount', { count: untranslated })}
          </button>
        )}
        {!prog && untranslated === 0 && data.skills.length > 0 && (
          <button class="btn sm" onClick={() => void enrich(true)}>
            🌐 {tr('skills.retranslate')}
          </button>
        )}
        <button class="btn sm" disabled={syncing} onClick={() => void sync()}>
          {syncing ? tr('skills.syncing') : `↻ ${tr('skills.syncMarket')}`}
        </button>
        {isAdmin && (
          <button class="btn sm" onClick={() => setAdminOpen(true)}>
            ⚙ {tr('skills.manageSourcesAction')}
          </button>
        )}
      </div>

      {data.needSync ? (
        <div class="empty">
          {tr('skills.marketNeedsSync')}
        </div>
      ) : (
        <>
          <div class="mkt-filters">
            <input
              class="mkt-search"
              placeholder={tr('skills.searchPlaceholder')}
              value={q}
              onInput={(e) => setQ(e.currentTarget.value)}
            />
            <label class="mkt-rec">
              <input type="checkbox" checked={recOnly} onChange={(e) => setRecOnly(e.currentTarget.checked)} />
              {tr('skills.recommendedOnly')}
            </label>
          </div>
          <div class="mkt-chips">
            <button class={`chip${mktFilter === '' ? ' on' : ''}`} onClick={() => setMktFilter('')}>
              {tr('skills.all')}
            </button>
            {data.markets
              .filter((m) => m.count > 0)
              .map((m) => (
                <button
                  key={m.name}
                  class={`chip${mktFilter === m.name ? ' on' : ''}`}
                  title={m.note}
                  onClick={() => setMktFilter(mktFilter === m.name ? '' : m.name)}
                >
                  {m.name} <span class="chip-n">{m.count}</span>
                </button>
              ))}
          </div>

          <div class="mkt-list">
            {filtered.length === 0 && <div class="empty">{tr('skills.noMatches')}</div>}
            {filtered.slice(0, 200).map((s) => {
              const st = inst[s.key] ?? {};
              const installed = installedNames.get(s.name);
              return (
                <div key={s.key} class="mkt-card">
                  <div class="mkt-hd">
                    <span class="mkt-nm" onClick={() => void preview(s)}>
                      {s.title}
                    </span>
                    {s.recommend && <span class="mkt-star" title={s.reason}>⭐ {tr('skills.recommended')}</span>}
                    <span class="skbadge">{s.market}</span>
                    {s.category && <span class="skbadge dim">{s.category}</span>}
                    {installed && <span class="mkt-inst">{tr('skills.installedBadge', { scope: installed === 'project' ? tr('view.project') : tr('skills.globalSkills') })}</span>}
                  </div>
                  {s.descZh && <div class="mkt-desc">{s.descZh}</div>}
                  <div class={`mkt-desc-en${s.descZh ? ' dim' : ''}`}>{s.description}</div>
                  {s.reason && <div class="mkt-reason">💡 {s.reason}</div>}
                  {!!s.tags?.length && (
                    <div class="mkt-tags">
                      {s.tags.map((t) => (
                        <span key={t} class="mkt-tag" onClick={() => setQ(t)}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <div class="mkt-ft">
                    {st.busy && <span class="mut small">{tr('skills.installing')}</span>}
                    {st.ok && <span class="ok small">{st.ok}</span>}
                    {st.err && <span class="err small">❌ {st.err}</span>}
                    <span class="flex1" />
                    <button class="linkbtn" onClick={() => void preview(s)}>
                      {tr('ui.view')}
                    </button>
                    <button class="btn sm primary" disabled={st.busy} onClick={() => void install(s, 'project')}>
                      {tr('skills.installProject')}
                    </button>
                    {isAdmin && (
                      <button class="btn sm" disabled={st.busy} onClick={() => void install(s, 'global')}>
                        {tr('skills.installGlobal')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {filtered.length > 200 && <div class="mut small">{tr('skills.matchLimit', { count: filtered.length })}</div>}
          </div>
        </>
      )}

      {adminOpen && (
        <MarketAdmin
          markets={data.markets}
          onClose={() => setAdminOpen(false)}
          onChanged={() => void load()}
        />
      )}
      {view && (
        <Modal title={view.title} onClose={() => setView(null)}>
          <div class="skv-body">
            <SkillMD text={view.content} />
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- 页面本体 ----------

export function SkillsView({ pid, me }: { pid: number; me: Me }) {
  const [project, setProject] = useState<Project | null>(null);
  const [sub, setSub] = useState<'installed' | 'market'>('installed');
  const [list, setList] = useState<SkillsList | null>(null);
  const [err, setErr] = useState('');
  const [view, setView] = useState<{ title: string; content: string } | null>(null);
  const isAdmin = me.role === 'admin';

  const load = (): void => {
    api<SkillsList>(`/api/projects/${pid}/skills`)
      .then((d) => {
        setList(d);
        setErr('');
      })
      .catch((e) => setErr(String((e as Error).message)));
  };

  useEffect(() => {
    api<Project>(`/api/projects/${pid}`).then(setProject).catch(() => {});
    load();
  }, [pid]);

  const openSkill = async (s: SkillInfo): Promise<void> => {
    try {
      const r = await api<{ ok: boolean; name: string; content: string }>(
        `/api/projects/${pid}/skills/file?path=${encodeURIComponent(s.path)}`,
      );
      setView({ title: s.name, content: r.content });
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const removeProject = async (s: SkillInfo): Promise<void> => {
    if (!confirm(tr('skills.uninstallProjectConfirm', { name: s.name }))) return;
    try {
      await api(`/api/projects/${pid}/skills/${encodeURIComponent(s.name)}`, 'DELETE');
      toast.success(tr('skills.uninstalled'));
      load();
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const removeGlobal = async (s: SkillInfo): Promise<void> => {
    if (!confirm(tr('skills.uninstallGlobalConfirm', { name: s.name }))) return;
    try {
      await api(`/api/admin/skills/global/${encodeURIComponent(s.name)}`, 'DELETE');
      toast.success(tr('skills.uninstalled'));
      load();
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  /** name → 已装范围（市场卡片「已装」徽章；项目优先） */
  const installedNames = useMemo(() => {
    const m = new Map<string, 'project' | 'global'>();
    for (const s of list?.global ?? []) m.set(s.name, 'global');
    for (const s of list?.project ?? []) m.set(s.name, 'project');
    return m;
  }, [list]);

  return (
    <div class="fullcol">
      <div class="bhead">
        <div class="bhead-row">
          <button class="back" onClick={() => nav(`/p/${pid}`)}>
            ‹
          </button>
          <span class="btitle">{tr('skills.pageTitle', { project: project?.name ?? tr('view.projectFallback', { id: pid }) })}</span>
          <div class="bacts">
            <button class={`btn sm${sub === 'installed' ? ' primary' : ''}`} onClick={() => setSub('installed')}>
              {tr('skills.installed')}
            </button>
            <button class={`btn sm${sub === 'market' ? ' primary' : ''}`} onClick={() => setSub('market')}>
              {tr('skills.market')}
            </button>
          </div>
        </div>
        {err && <div class="err">{err}</div>}
      </div>

      {sub === 'installed' ? (
        <div class="sklists">
          {list === null && !err && <Loading />}
          {list && (
            <>
              <div class="sksec">
                <div class="sksec-hd">
                  {tr('skills.projectSkills')} <span class="mut small">{tr('skills.projectSkillsPath', { path: list.cwd })}</span>
                </div>
                {list.project.length === 0 && <div class="empty">{tr('skills.noProjectSkills')}</div>}
                {list.project.map((s) => (
                  <SkillRow key={s.path} s={s} onView={() => void openSkill(s)} onRemove={() => void removeProject(s)} />
                ))}
              </div>
              <div class="sksec">
                <div class="sksec-hd">
                  {tr('skills.globalSkills')} <span class="mut small">{tr('skills.globalSkillsPath')}</span>
                </div>
                {list.global.length === 0 && <div class="empty">{tr('skills.noGlobalSkills')}</div>}
                {list.global.map((s) => (
                  <SkillRow
                    key={s.path}
                    s={s}
                    onView={() => void openSkill(s)}
                    onRemove={isAdmin && s.source === '内置' ? () => void removeGlobal(s) : undefined}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <Market pid={pid} isAdmin={isAdmin} installedNames={installedNames} onInstalled={load} />
      )}

      {view && (
        <Modal title={view.title} onClose={() => setView(null)}>
          <div class="skv-body">
            <SkillMD text={view.content} />
          </div>
        </Modal>
      )}
    </div>
  );
}
