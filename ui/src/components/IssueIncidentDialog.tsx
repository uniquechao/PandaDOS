import { useEffect, useRef, useState } from 'preact/hooks';
import type { IssueId } from '../../../shared/issue-id';
import type { IncidentView } from '../../../shared/issue-incidents';
import { api, ApiError } from '../lib/api';
import { prepareIncidentRequest, incidentRequestRejected, type IncidentRequest } from '../lib/incident-requests';
import { runtimeI18n, tr } from '../i18n/runtime';
import { Modal } from './Modal';
import { IssueIncidentIcon as Icon } from './IssueIncidentIcon';
import { incidentEvidence } from '../lib/incident-evidence';
import { fmtTime, timeAgo } from '../lib/fmt';

interface Saved {draft:string;guidance:string;request:IncidentRequest|null}
export function IssueIncidentDialog({pid,issueId,onClose}:{pid:number;issueId:IssueId;onClose:()=>void}) {
  const [view,setView]=useState<IncidentView|null>(null);
  const messages=view?.messages.filter(m=>m.requestKey!=='initial'||m.role==='assistant')??[];
  const [draft,setDraft]=useState('');const [guidance,setGuidance]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [success,setSuccess]=useState(false);
  const [pending,setPending]=useState<IncidentRequest|null>(null);
  const saved=useRef<Saved>({draft:'',guidance:'',request:null});const storageKey=useRef('');
  const live=useRef(true);const running=useRef(false);const scroll=useRef<HTMLDivElement>(null);const atEnd=useRef(true);
  const generation=useRef(0);
  const previousMessageCount=useRef(0);
  const base=`/api/projects/${pid}/issues/${issueId}/incidents`;
  const save=(patch:Partial<Saved>)=>{
    saved.current={...saved.current,...patch};
    if(storageKey.current)try{localStorage.setItem(storageKey.current,JSON.stringify(saved.current));}catch{/* memory retains the request for this mounted dialog */}
  };
  const accept=(next:IncidentView)=>{
    if(!live.current)return;
    if(!storageKey.current && next.viewerUserId) {
      storageKey.current=`panda.incidents.${next.viewerUserId}.${pid}.${issueId}.${next.incident.id}`;
      try {
        const prior=JSON.parse(localStorage.getItem(storageKey.current)??'null') as Saved|null;
        if(prior && typeof prior.draft==='string' && typeof prior.guidance==='string') {
          saved.current={draft:prior.draft.slice(0,4000),guidance:prior.guidance.slice(0,4000),request:prior.request??null};
          setDraft(saved.current.draft);setGuidance(saved.current.guidance);setPending(saved.current.request);
        }
      } catch{/* damaged browser draft cannot change the server incident */}
    }
    const request=saved.current.request;
    if(request && (request.kind==='send' && next.messages.some(m=>m.requestKey===request.key)
      || request.kind==='resolve' && next.incident.state!=='open')) {
      save({request:null,...(request.kind==='send'?{draft:''}:{})});setPending(null);
      if(request.kind==='send')setDraft('');
    }
    setView(next);
  };
  useEffect(()=>{
    live.current=true;let timer:ReturnType<typeof setTimeout>|undefined;
    const abort=new AbortController();
    const poll=async()=>{
      if(!live.current)return;
      const id=currentId;
      const epoch=generation.current;
      try {if(id && !running.current) {const next=await api<IncidentView>(`${base}/${id}`,'GET',undefined,{signal:abort.signal});if(epoch===generation.current)accept(next);}}
      catch(cause){if(live.current && !abort.signal.aborted)setError(String(cause));}
      if(live.current)timer=setTimeout(poll,1500);
    };
    let currentId='';
    void api<IncidentView>(`${base}/open`,'POST',{locale:runtimeI18n().locale},{signal:abort.signal})
      .then(next=>{if(!live.current)return;currentId=next.incident.id;accept(next);timer=setTimeout(poll,800);})
      .catch(cause=>{if(live.current)setError(String(cause));});
    return()=>{live.current=false;abort.abort();clearTimeout(timer);};
  },[pid,issueId]);
  useEffect(()=>{
    // Keep the cause visible for the first automatic answer, then follow new replies only at the end.
    if(messages.length>previousMessageCount.current && atEnd.current && scroll.current
      && (previousMessageCount.current>0 || messages.length>1))scroll.current.scrollTop=scroll.current.scrollHeight;
    previousMessageCount.current=messages.length;
  },[messages.length]);
  const operate=async(request:IncidentRequest)=>{
    if(!view || running.current)return;
    running.current=true;setBusy(true);setError('');setSuccess(false);
    generation.current++;
    save({request});setPending(request);
    const suffix={send:'messages',resolve:'resolve-and-resume',action:'actions',refresh:'refresh'}[request.kind];
    try {
      const result=await api<IncidentView|{ok:boolean;error?:string}>(`${base}/${view.incident.id}/${suffix}`,'POST',{key:request.key,...request.payload});
      generation.current++;
      save({request:null,...(request.kind==='send'?{draft:''}:{})});
      if(live.current){setPending(null);if(request.kind==='send')setDraft('');}
      if('incident' in result)accept(result);
      else {
        if(!result.ok)throw new Error(result.error??tr('incident.error'));
        if(live.current)setSuccess(request.kind==='action');
        accept(await api<IncidentView>(`${base}/${view.incident.id}`));
      }
    } catch(cause) {
      if(cause instanceof ApiError && incidentRequestRejected(cause)) {save({request:null});if(live.current)setPending(null);}
      if(live.current)setError(String(cause));
    } finally {running.current=false;if(live.current)setBusy(false);}
  };
  const submit=(kind:IncidentRequest['kind'],payload:Record<string,string>)=>{
    try {void operate(prepareIncidentRequest(saved.current.request,kind,payload));}catch(cause){setError(String(cause));}
  };
  const stop=async()=>{
    if(!view || running.current)return;setBusy(true);running.current=true;
    try {accept(await api<IncidentView>(`${base}/${view.incident.id}/stop`,'POST',{}));}
    catch(cause){if(live.current)setError(String(cause));}
    finally{running.current=false;if(live.current)setBusy(false);}
  };
  const writable=!!view?.current && view.incident.state==='open';
  const analyzing=!!view && ['running','queued'].includes(view.incident.runState);
  const stateLabel=!view ? error ? 'incident.failed' : 'incident.analyzing' : view.incident.state==='queued' ? 'incident.queued'
    : view.incident.state==='resumed' ? 'incident.resumed' : !view.current ? 'incident.stale'
    : analyzing ? 'incident.analyzing' : view.incident.runState==='failed' ? view.incident.error?.startsWith('incident_recovery_failed:') ? 'incident.recoveryFailed' : 'incident.failed'
    : view.incident.runState==='interrupted' ? 'incident.interrupted' : 'incident.waiting';
  const stateBadge=busy ? 'incident.stateRunning' : !view ? error ? 'incident.stateFailed' : 'incident.stateAnalyzing'
    : view.incident.state==='queued' ? 'incident.stateQueued' : view.incident.state==='resumed' ? 'incident.stateResumed'
    : !view.current ? 'incident.stateStale' : analyzing ? 'incident.stateAnalyzing' : view.incident.runState==='failed' ? 'incident.stateFailed'
    : view.incident.runState==='interrupted' ? 'incident.stateInterrupted' : 'incident.stateWaiting';
  const facts=incidentEvidence(view?.evidence??'');
  const loadingCause=!error && (!view || analyzing) && !facts.branchMismatch && !facts.failure;
  const showStatus=!!view && (!writable || ['failed','interrupted'].includes(view.incident.runState));
  const preserved=!!view?.current && facts.workspaceReadable && ['paused','blocked'].includes(view.issueStatus);
  return <Modal title={tr('incident.title')} wide className="incident-dialog" onClose={onClose}>
    <button type="button" class="incident-close" aria-label={tr('incident.close')} onClick={onClose}><Icon name="close"/></button>
    <div class="incident-context"><code>#{issueId}</code><span class="incident-context-separator" aria-hidden="true"/>
      <span>{tr('incident.session')}</span><span class="incident-state-pill">{tr(stateBadge)}</span>
    </div>
    <p class="sr-only">{tr('incident.intro')}</p>
    <div ref={scroll} class="incident-scroll" onScroll={()=>{const e=scroll.current;if(e)atEnd.current=e.scrollHeight-e.scrollTop-e.clientHeight<60;}}>
      <p class={`incident-status${showStatus ? ' incident-notice' : ' sr-only'}`} role="status">{busy ? tr('incident.runningAction') : tr(stateLabel)}</p>
      {error && <div class="incident-feedback incident-feedback-error" role="alert"><p>{tr('incident.error')}</p><details><summary>{tr('incident.evidence')}</summary><pre>{error}</pre></details></div>}
      {success && <p class="incident-feedback" role="status">{tr('incident.actionDone')}</p>}
      <section class="incident-cause" aria-label={tr('incident.stopReason')} aria-busy={loadingCause}>
        <div class="incident-cause-heading"><span class="incident-cause-icon"><Icon name={facts.branchMismatch?'branch':'alert'}/></span>
          <div><div class="incident-eyebrow">{tr('incident.stopReason')}</div><h4>{tr(facts.branchMismatch ? 'issue.stopBranchMismatch' : loadingCause ? 'incident.reasonPending' : facts.failure ? 'incident.recordedFailure' : 'incident.unknownReason')}</h4></div>
          {facts.branchMismatch && <span class="incident-verified"><Icon name="check"/>{tr('incident.verified')}</span>}
        </div>
        <p class="incident-cause-description">{facts.branchMismatch ? tr('incident.branchDescription') : facts.failure ? facts.failure.split('\n')[0]!.slice(0,480) : tr(loadingCause?'incident.analyzing':'incident.unknownHint')}</p>
        {(facts.actual || facts.expected) && <dl class="incident-branches">
          {facts.actual && <div><dt>{tr('incident.actualBranch')}</dt><dd><code>{facts.actual}</code></dd></div>}
          {facts.expected && <div><dt>{tr('incident.expectedBranch')}</dt><dd><code>{facts.expected}</code></dd></div>}
        </dl>}
        {(preserved || writable) && <p class="incident-preserved"><Icon name="shield"/>{tr(preserved?'incident.progressPreserved':'incident.holdHint')}</p>}
      </section>
      <div class="incident-disclosures">
        {view && <details class="incident-evidence"><summary><Icon name="chevron"/><Icon name="evidence"/><span>{tr('incident.evidence')}</span><small>{tr('incident.viewRecords')}</small></summary>
          <div class="incident-disclosure-body">{view.incident.error && <pre>{view.incident.error}</pre>}<pre>{view.evidence}</pre></div>
        </details>}
        {writable && <details class="incident-repair"><summary><Icon name="chevron"/><Icon name="tools"/><span>{tr('incident.actions')}</span><small>{tr('incident.manualAction')}</small></summary>
          <div class="incident-disclosure-body"><p>{tr('incident.actionHelp')}</p><div class="incident-actions">
            <button class="btn sm" disabled={busy||analyzing||!!pending||!facts.sha} onClick={()=>submit('action',{kind:'environment',sha:facts.sha})}>{tr('incident.environment')}</button>
            <button class="btn sm" disabled={busy||analyzing||!!pending||!facts.sha} onClick={()=>submit('action',{kind:'branch',sha:facts.sha})}>{tr('incident.branch')}</button>
            <button class="btn sm" disabled={busy||analyzing||!!pending||!facts.sha} onClick={()=>submit('action',{kind:'verify',sha:facts.sha})}>{tr('incident.verifyAction')}</button>
          </div></div>
        </details>}
      </div>
      <section class="incident-conversation">
        <div class="incident-conversation-heading"><h4>{tr('incident.conversation')}</h4><span>{tr('incident.historySaved')}</span>
          {writable && (analyzing
            ? <button class="incident-text-button" disabled={busy} onClick={()=>void stop()}><Icon name="stop"/>{tr('incident.stop')}</button>
            : <button class="incident-text-button" disabled={busy||!!pending} onClick={()=>submit('refresh',{})}><Icon name="refresh"/>{tr('incident.recheck')}</button>)}
        </div>
        <div class="incident-messages" role="log" aria-label={tr('incident.title')} aria-live="polite" aria-busy={analyzing}>
          {messages.map(message=><article key={message.id} class={`incident-message ${message.role}`}>
            {message.role==='assistant' && <span class="incident-avatar"><Icon name="assistant"/></span>}
            <div class="incident-message-body"><div class="incident-message-meta"><span>{tr(message.role==='user'?'incident.me':'incident.analyst')}</span>
              {Number.isFinite(message.createdTs) && <span title={fmtTime(message.createdTs)}>{timeAgo(message.createdTs)}</span>}
            </div><p class="incident-bubble">{message.content}</p></div>
          </article>)}
          {analyzing && <p class="incident-analysis-progress" role="status"><span aria-hidden="true"/>{tr('incident.analyzing')}</p>}
        </div>
      </section>
      {pending && <div class="incident-feedback incident-pending" role="status"><p>{tr('incident.pending')}</p><button class="btn sm" disabled={busy} onClick={()=>void operate(pending)}>{tr('incident.retry')}</button></div>}
    </div>
    {writable && <form class="incident-composer" onSubmit={e=>{e.preventDefault();submit('send',{content:draft.trim()});}}>
      <label>{tr('incident.continueLabel')}<div class="incident-composer-box">
        <textarea aria-label={tr('incident.placeholder')} placeholder={tr('incident.placeholder')} maxLength={4000} value={draft} disabled={busy||!!pending}
          onInput={e=>{setDraft(e.currentTarget.value);save({draft:e.currentTarget.value});}} />
        <button class="incident-send" type="submit" aria-label={tr('incident.send')} title={tr('incident.send')} disabled={busy||analyzing||!!pending||!draft.trim()}><Icon name="send"/></button>
      </div></label>
    </form>}
    <footer class="incident-footer">
      {writable && <label class="incident-resolution-field"><span>{tr('incident.resolutionLabel')}<small>{tr('incident.resolutionHelp')}</small></span>
        <input aria-label={tr('incident.guidance')} placeholder={tr('incident.guidance')} maxLength={4000} value={guidance} disabled={busy||!!pending}
          onInput={e=>{setGuidance(e.currentTarget.value);save({guidance:e.currentTarget.value});}} />
      </label>}
      <div class="incident-footer-actions"><span class="incident-close-note"><Icon name="save"/>{tr('incident.closeNote')}</span>
        <button class="btn incident-footer-close" onClick={onClose}>{tr('incident.close')}</button>
        {writable && <button class="btn primary" disabled={busy||!!pending||!guidance.trim()} onClick={()=>submit('resolve',{guidance:guidance.trim()})}><Icon name="check"/>{tr('incident.resolve')}</button>}
      </div>
    </footer>
  </Modal>;
}
