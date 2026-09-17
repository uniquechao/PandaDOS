import { useEffect,useState } from 'preact/hooks';
import { api } from '../lib/api';
import { tr } from '../i18n/runtime';
import type { SkillsList } from '../lib/types';
type Policy=Record<string,'auto'|'manual'|'disabled'>;
export function SkillPolicyEditor({pid,moduleId,issueId,value,onChange}: {
 pid:number;moduleId?:number;issueId?:number;value?:Policy;onChange?:(value:Policy)=>void;
}) {
 const [policy,setPolicy]=useState<Policy>({}),[names,setNames]=useState<string[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const url=`/api/projects/${pid}/skill-policy${issueId ? '?issueId='+issueId : moduleId ? '?moduleId='+moduleId : ''}`;
 useEffect(()=>{
  let live=true;
  Promise.all([api<{policy:Policy}>(url),api<SkillsList>(`/api/projects/${pid}/skills`)]).then(([p,s])=>{
   if(!live)return;setPolicy(p.policy);setNames([...new Set([...s.global,...s.project].map(s=>s.name))].sort());
  }).catch(e=>{if(live)setError(String(e));});
  return ()=>{live=false;};
 },[url]);
 const selected=value ?? policy;
 async function save(){setBusy(true);try{await api(url,'PUT',policy);setError('');}catch(e){setError(String(e));}finally{setBusy(false);}}
 return <details class="gate-box"><summary>{tr('status.skillPolicy')}</summary>
  <p class="mut small">{tr('status.skillPolicyHint')}</p>
  {names.map(name=><label class="row" key={name}><span>{name}</span><select value={selected[name] ?? ''} disabled={busy}
    onChange={e=>{const next={...selected};const mode=e.currentTarget.value;if(mode)next[name]=mode as Policy[string];else delete next[name];onChange ? onChange(next) : setPolicy(next);}}>
    <option value="">{tr('status.inherit')}</option><option value="auto">{tr('status.skillAuto')}</option><option value="manual">{tr('status.skillManual')}</option><option value="disabled">{tr('status.skillDisabled')}</option>
  </select></label>)}
  {!onChange && <button class="btn" disabled={busy} onClick={save}>{tr('ui.save')}</button>}
  {error && <div class="err">{error}</div>}
 </details>;
}
