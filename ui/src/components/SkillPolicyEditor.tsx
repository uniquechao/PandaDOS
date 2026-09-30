import { useEffect,useMemo,useRef,useState } from 'preact/hooks';
import { api } from '../lib/api';
import { tr } from '../i18n/runtime';
import type { MessageKey } from '../../../shared/i18n/messages';
import type { SkillInfo,SkillsList } from '../lib/types';
import type { IssueId } from '../../../shared/issue-id';
import { Loading } from './Loaders';

type Mode='auto'|'manual'|'disabled';
type Policy=Record<string,Mode>;
type Filter='all'|'custom'|Mode;
interface Row { name:string; summary:string; scope:SkillInfo['scope']; parent?:Mode; own?:Mode; mode:Mode }

const MODE_KEY: Record<Mode,MessageKey>={auto:'status.skillAuto',manual:'status.skillManual',disabled:'status.skillDisabled'};
const MODES: (Mode|'')[]=['','auto','manual','disabled'];
const FILTERS: Filter[]=['all','custom','auto','manual','disabled'];
const sameSet=(a:Policy,b:Policy)=>{const ka=Object.keys(a);return ka.length===Object.keys(b).length && ka.every(k=>a[k]===b[k]);};
/** 与后端 core/skill-policy.skillMode 的缺省值一致：superpowers 默认仅手动，其余自动 */
const defaultMode=(s:SkillInfo):Mode=>/superpowers/i.test(`${s.source ?? ''}/${s.path}`) ? 'manual' : 'auto';

/** 技能策略编辑器：项目 / 模块 / issue 三层覆盖。传 onChange 时为受控表单件（新建 issue），否则自带保存。 */
export function SkillPolicyEditor({pid,moduleId,issueId,value,onChange}: {
 pid:number;moduleId?:number;issueId?:IssueId;value?:Policy;onChange?:(value:Policy)=>void;
}) {
 const [policy,setPolicy]=useState<Policy>({}),[saved,setSaved]=useState<Policy>({}),[effective,setEffective]=useState<Policy>({});
 const [skills,setSkills]=useState<SkillInfo[]|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[justSaved,setJustSaved]=useState(false);
 const [query,setQuery]=useState(''),[filter,setFilter]=useState<Filter>('all');
 const savedTimer=useRef<ReturnType<typeof setTimeout>>();
 const url=`/api/projects/${pid}/skill-policy${issueId ? '?issueId='+issueId : moduleId ? '?moduleId='+moduleId : ''}`;
 useEffect(()=>{
  let live=true;setSkills(null);
  Promise.all([api<{policy:Policy;effective?:Policy}>(url),api<SkillsList>(`/api/projects/${pid}/skills`)]).then(([p,s])=>{
   if(!live)return;
   setPolicy(p.policy);setSaved(p.policy);setEffective(p.effective ?? {});
   const byName=new Map<string,SkillInfo>();
   for(const skill of [...s.global,...s.project])byName.set(skill.name,skill); // 同名以项目级为准
   setSkills([...byName.values()].sort((a,b)=>a.name.localeCompare(b.name)));setError('');
  }).catch(e=>{if(live){setError(String(e));setSkills([]);}});
  return ()=>{live=false;};
 },[url]);
 useEffect(()=>()=>clearTimeout(savedTimer.current),[]);

 const selected=value ?? policy;
 const rows=useMemo<Row[]>(()=>(skills ?? []).map(s=>{
  // 受控模式拿到的是上层（项目⊕模块）生效值；自带保存时 effective 含本层已存覆盖，只能对未覆盖项推出继承值
  const parent=onChange || !(s.name in saved) ? effective[s.name] ?? defaultMode(s) : undefined;
  const own=selected[s.name];
  // frontmatter 里 `description: >` 折叠块只被解析出标记符本身时不展示
  const summary=/^[>|][-+]?$/.test(s.summary.trim()) ? '' : s.summary;
  return {name:s.name,summary,scope:s.scope,parent,own,mode:own ?? parent ?? defaultMode(s)};
 }),[skills,selected,saved,effective,onChange]);
 const counts=useMemo(()=>{
  const c: Record<Filter,number>={all:rows.length,custom:0,auto:0,manual:0,disabled:0};
  for(const r of rows){c[r.mode]++;if(r.own)c.custom++;}
  return c;
 },[rows]);
 const q=query.trim().toLowerCase();
 const visible=rows.filter(r=>(filter==='all' || (filter==='custom' ? !!r.own : r.mode===filter))
  && (!q || r.name.toLowerCase().includes(q) || r.summary.toLowerCase().includes(q)));
 const dirty=!onChange && !sameSet(policy,saved);

 function commit(next:Policy){onChange ? onChange(next) : setPolicy(next);setJustSaved(false);}
 function pick(name:string,mode:Mode|''){const next={...selected};if(mode)next[name]=mode;else delete next[name];commit(next);}
 async function save(){
  setBusy(true);
  try{
   const r=await api<{policy:Policy;effective?:Policy}>(url,'PUT',policy);
   setPolicy(r.policy);setSaved(r.policy);if(r.effective)setEffective(r.effective);setError('');
   setJustSaved(true);clearTimeout(savedTimer.current);savedTimer.current=setTimeout(()=>setJustSaved(false),900);
  }catch(e){setError(String(e));}finally{setBusy(false);}
 }

 return <details class="skp">
  <summary class="skp-head">
   <svg class="skp-chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
   <span class="skp-title">{tr('status.skillPolicy')}</span>
   {skills && <span class="skp-meta">
    <span class={`skp-badge${counts.custom ? ' on' : ''}`}>{counts.custom ? tr('status.skillOverrideCount',{count:counts.custom}) : tr('status.skillAllInherited')}</span>
    <span class="skp-total">{tr('status.skillCount',{count:counts.all})}</span>
    {dirty && <span class="skp-dirty" title={tr('status.skillUnsaved')} aria-label={tr('status.skillUnsaved')} />}
   </span>}
  </summary>
  <div class="skp-body">
   <p class="skp-hint">{tr('status.skillPolicyHint')}</p>
   {skills===null ? <Loading /> : skills.length===0 ? (!error && <div class="skp-empty">{tr('status.skillNone')}</div>) : <>
    <div class="skp-tools">
     <label class="skp-search">
      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>
      <input type="search" value={query} placeholder={tr('status.skillSearch')} aria-label={tr('status.skillSearch')}
       onInput={e=>setQuery(e.currentTarget.value)} />
      {query && <button type="button" class="skp-clear" aria-label={tr('status.skillClearSearch')} onClick={()=>setQuery('')}>
       <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></svg>
      </button>}
     </label>
     <div class="skp-filters" role="group" aria-label={tr('status.skillFilterAria')}>
      {FILTERS.map(f=><button type="button" key={f} class={`skp-chip${filter===f ? ' on' : ''}`} aria-pressed={filter===f}
       disabled={f!=='all' && !counts[f] && filter!==f} onClick={()=>setFilter(f)}>
       {tr(f==='all' ? 'status.skillFilterAll' : f==='custom' ? 'status.skillFilterCustom' : MODE_KEY[f])}
       <span class="skp-chip-n">{counts[f]}</span>
      </button>)}
     </div>
    </div>
    {visible.length===0 ? <div class="skp-empty">{tr('status.skillNoMatch')}</div> :
    <ul class="skp-list">
     {visible.map(r=><li key={r.name} class={`skp-row${r.own ? ' custom' : ''}`}>
      <div class="skp-info">
       <div class="skp-line">
        <span class="skp-name" title={r.name}>{r.name}</span>
        <span class="skp-scope">{tr(r.scope==='project' ? 'status.skillScopeProject' : 'status.skillScopeGlobal')}</span>
        {!r.own && r.parent && <span class="skp-eff">{tr('status.skillInheritsMode',{mode:tr(MODE_KEY[r.parent])})}</span>}
       </div>
       {r.summary && <div class="skp-sum" title={r.summary}>{r.summary}</div>}
      </div>
      <div class="skp-seg" role="radiogroup" aria-label={tr('status.skillModeAria',{name:r.name})}>
       {MODES.map(m=>{
        const on=(r.own ?? '')===m;
        const label=m ? tr(MODE_KEY[m]) : tr('status.inherit');
        const hint=!m && r.parent ? tr('status.skillInheritsMode',{mode:tr(MODE_KEY[r.parent])}) : undefined;
        return <button type="button" key={m || 'inherit'} role="radio" aria-checked={on} disabled={busy} title={hint}
         class={`skp-opt${on ? ' on' : ''}${m==='disabled' ? ' off' : ''}`} onClick={()=>pick(r.name,m)}>
         {label}
        </button>;
       })}
      </div>
     </li>)}
    </ul>}
    {(counts.custom>0 || !onChange) && <div class="skp-foot">
     {counts.custom>0 && <button type="button" class="skp-reset" disabled={busy} onClick={()=>commit({})}>{tr('status.skillResetAll')}</button>}
     {!onChange && <span class="skp-save">
      {dirty && <span class="skp-note">{tr('status.skillUnsaved')}</span>}
      {justSaved && !dirty && <span class="skp-note ok" role="status">{tr('ui.saved')}</span>}
      <button type="button" class="btn sm primary" disabled={busy || !dirty} onClick={save}>{busy ? tr('ui.saving') : tr('ui.save')}</button>
     </span>}
    </div>}
   </>}
   {error && <div class="err">{error}</div>}
  </div>
 </details>;
}
