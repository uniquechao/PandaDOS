/** 隔离真实浏览器回归：只装载当前组件，模拟 API，不操作服务或 issue。 */
import assert from 'node:assert/strict';
import { readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createServer } from 'vite';
import { testTmuxDirectory } from './test-tmux';

const dir = testTmuxDirectory(); // 公共仓库短目录，深层 worktree 也不超过 Unix socket 上限。
const fixture = `
import { h, render } from 'preact';
import { IssueStopNotice, BlockedRecoveryModal } from '/src/views/IssueDetail.tsx';
import { setRuntimeI18n } from '/src/i18n/runtime.ts';
import { createI18n } from '/@fs/${resolve('shared/i18n/formatter.ts')}';
import { catalogs } from '/@fs/${resolve('shared/i18n/catalogs/index.ts')}';
import '/src/style.css';
window.showScenario = (kind = 'validation', locale = 'zh-Hans') => {
  setRuntimeI18n(createI18n({ locale, timeZone: 'Asia/Shanghai', catalog: catalogs[locale] }));
  const entries = kind === 'validation' ? [
    ['validation_failed', { label: 'test', summaryTruncated: true, tail: '(fail) 真实失败名称\\nError: expected 1' }],
    ['tests_failed', { failCount: 4 }],
    ['transition', { from: 'testing', to: 'paused', event: 'tests_failed' }],
  ] : kind === 'branch' ? [
    ['environment_preparation_failed', { note: 'Error: 工作区分支发生变化，需恢复原分支' }],
    ['transition', { from: 'testing', to: 'paused', event: 'pause', note: '执行工作区不可用，恢复后重试验证' }],
    ['error', { where: 'git-tip', error: '当前分支为 codex/20261106-11d291c-prototype-baseline，issue 工作分支应为 panda/module-2-1' }],
  ] : kind === 'environment' ? [
    ['environment_preparation_failed', { note: 'install failed' }],
    ['transition', { from: 'testing', to: 'paused', event: 'pause' }],
  ] : [['transition', { from: 'implementing', to: 'paused', event: 'pause', stopLoss: kind === 'budget' }]];
  const events = entries.map(([kind, data], i) => ({ id: i + 1, kind, dataJson: JSON.stringify(data), ts: 1793704975718 + i }));
  render(h(IssueStopNotice, { key: kind + locale, pid: 1, issue: { id: 'test', status: kind === 'blocked' ? 'blocked' : kind === 'clarify' ? 'implementing' : 'paused', awaitingClarify: kind === 'clarify', note: 'Error: technical details' }, events }), document.querySelector('#root'));
};
window.showRecovery = (status) => {
  window.recoverySubmitted = 0;
  render(h(BlockedRecoveryModal, {
    key: status, issue: { status }, blockedReason: 'Error: failed', guidance: '', busy: false, error: '', canEditSubtask: false,
    onGuidanceChange() {}, onClose() { render(null, document.querySelector('#root')); }, onEditIssue() {}, onEditSubtask() {},
    onSubmit() { window.recoverySubmitted++; },
  }), document.querySelector('#root'));
};
window.clearScenario = () => render(null,document.querySelector('#root'));
window.showScenario();
`;
let incident;
let initialAnalyses=0, sends=0, resumes=0, failedOnce=false;
let fixtureMode='normal';
const fixtureEvidence=()=>fixtureMode==='unknown' ? JSON.stringify({events:[{kind:'error',data:{error:'Package install failed'}}]}) : JSON.stringify({headSha:'a'.repeat(40),actualBranch:fixtureMode==='long'?'codex/'+ 'a'.repeat(180):'codex/prototype',workspace:{cwd:'/fixture/workspace',expectedBranch:'panda/module-1'}});
const requests=new Map();
const incidentView=()=>({incident:incident??{id:'fault-fixture',issueId:'test',projectId:1,stopEventId:3,attemptId:null,state:'open',runState:'running',locale:'zh-Hans',error:null,createdTs:Date.now()},messages:[...requests.values()],issueStatus:fixtureMode==='stale'?'testing':'paused',current:fixtureMode!=='stale',pendingRecovery:incident?.state==='queued',viewerUserId:1,evidence:fixtureEvidence()});
const server = await createServer({ root: 'ui', configFile: 'ui/vite.config.ts', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['preact', 'preact/hooks', 'preact/compat', 'preact/jsx-dev-runtime'] }, plugins: [{
  name: 'diagnostic-fixture',
  configureServer(server) {
    server.middlewares.use('/__diagnostics', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__fixture.js"></script>'); });
    server.middlewares.use('/__incident-mode',(req,res)=>{
      fixtureMode=new URL(req.url,'http://fixture').searchParams.get('state')??'normal';
      if(fixtureMode==='normal')for(const [key,message] of requests)if(message.role==='user')requests.delete(key);
      if(fixtureMode==='history')for(let i=0;i<12;i++)requests.set('history-'+i,{id:100+i,role:'assistant',content:('Historical diagnostic message '+i+'\n').repeat(5),requestKey:'history-'+i,state:'done',createdTs:Date.now()});
      if(fixtureMode==='append')requests.set('new-reply',{id:200,role:'assistant',content:'A new reply arrived while you read history.',requestKey:'new-reply',state:'done',createdTs:Date.now()});
      if(incident){incident.state=fixtureMode==='queued'?'queued':fixtureMode==='stale'?'stale':'open';incident.runState=fixtureMode==='analyzing'?'running':fixtureMode==='failed'?'failed':'idle';incident.error=fixtureMode==='failed'?'incident_recovery_failed: process stop not confirmed':null;}
      res.setHeader('Content-Type','application/json');res.end('{}');
    });
    server.middlewares.use('/__incident-stats',(_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({initialAnalyses,sends,resumes,keys:[...requests.keys()]}));});
    server.middlewares.use('/api/projects/1/issues/test/incidents',async(req,res)=>{
      res.setHeader('Content-Type','application/json');
      let body='';for await(const chunk of req)body+=chunk;
      const b=body?JSON.parse(body):{};
      if(req.url==='/open'){
        if(fixtureMode==='open-error'){res.statusCode=503;res.end(JSON.stringify({error:'fixture diagnosis unavailable'}));return;}
        if(!incident){incident=incidentView().incident;initialAnalyses++;setTimeout(()=>{incident.runState='idle';requests.set('initial',{id:1,role:'assistant',content:'已核实：现场 codex/prototype 与登记 panda/module-1 不一致。请先确认要保留的基线。',requestKey:'initial',state:'done',createdTs:Date.now()});},100);}
      }else if(req.url.endsWith('/messages')){
        if(!requests.has(b.key)){sends++;requests.set(b.key,{id:2,role:'user',content:b.content,requestKey:b.key,state:'done',createdTs:Date.now()});}
        if(!failedOnce){failedOnce=true;res.statusCode=503;res.end(JSON.stringify({error:'response lost after commit'}));return;}
      }else if(req.url.endsWith('/resolve-and-resume')){if(incident.state==='open'){resumes++;incident.state='queued';}}
      else if(req.url.endsWith('/refresh')){incident.runState='idle';}
      res.end(JSON.stringify(incidentView()));
    });
    server.middlewares.use('/api/projects/1/issues/test/diagnostics', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ retainedOutput: true, events: [{ id: 10, kind: 'validation_diagnostic', ts: 1793704975718, dataJson: JSON.stringify({ argv: ['bun', 'test'], out: 'original stdout', err: '(fail) 真实失败名称\nError: expected 1', sourceTruncated: true }) }] }));
    });
  },
  resolveId(id) { if (id === '/__fixture.js') return '\0diagnostic-fixture'; },
  load(id) { if (id === '\0diagnostic-fixture') return fixture; },
}] });
let chrome, ws, socketDir, chromeErrors;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error('等待浏览器验证超时'); }
try {
  await server.listen();
  chrome = Bun.spawn([process.env.CHROMIUM_PATH || '/usr/bin/google-chrome', '--headless', '--no-proxy-server', '--disable-extensions', '--disable-background-networking', '--no-sandbox', '--no-zygote', '--disable-gpu', '--disable-features=NetworkServiceSandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdout: 'ignore', stderr: 'pipe', env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TMPDIR: dir } });
  chromeErrors = new Response(chrome.stderr).text();
  console.log('启动隔离浏览器');
  const port = await until(async () => { try { return (await readFile(`${dir}/DevToolsActivePort`, 'utf8')).split('\n')[0]; } catch {} });
  const socket = await readlink(`${dir}/SingletonSocket`);
  socketDir = dirname(socket);
  console.log('浏览器已就绪');
  await delay(300);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  let seq = 0; const pending = new Map();
  ws.onmessage = message => { const data = JSON.parse(message.data); const p = pending.get(data.id); if (p) { pending.delete(data.id); data.error ? p.reject(data.error) : p.resolve(data.result); } };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); const timer=setTimeout(()=>{if(pending.delete(id))reject(Error('CDP timeout: '+method));},20000); timer.unref(); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable'); await cdp('Network.enable');
  ws.addEventListener('message', e => { const d = JSON.parse(e.data); if (['Runtime.exceptionThrown', 'Log.entryAdded', 'Network.loadingFailed'].includes(d.method)) console.error(JSON.stringify(d.params)); });
  console.log('装载组件夹具');
  await cdp('Page.navigate', { url: `http://127.0.0.1:${server.httpServer.address().port}/__diagnostics` });
  try { await until(() => evaluate('!!document.querySelector(".issue-stop")')); } catch (e) { console.error(await evaluate('document.body.innerHTML')); throw e; }
  console.log('组件已装载');
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR', 'ru']) {
    await evaluate(`window.showScenario('validation', '${locale}')`);
    await until(() => evaluate('document.querySelector(".issue-stop strong")?.textContent.includes("验收失败")'));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${locale} 手机不横向溢出`);
    assert.match(await evaluate('document.querySelector(".issue-stop").innerText'), /系统暂停.*验收失败/s);
    assert.match(await evaluate('document.querySelector(".issue-stop").innerText'), /真实失败名称/);
    assert.match(await evaluate('document.querySelector(".issue-stop").innerText'), /摘要已裁剪/);
    assert.equal(await evaluate('document.querySelector(".stop-raw").closest("details").open'), false, '技术详情默认折叠');
  }
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR', 'ru']) {
    await evaluate(`window.showScenario('branch', '${locale}')`);
    await until(() => evaluate('document.querySelector(".issue-stop-reason")?.textContent.includes("codex/20261106-11d291c-prototype-baseline")'));
    assert.match(await evaluate('document.querySelector(".issue-stop-reason").textContent'), /panda\/module-2-1/);
    assert.equal(await evaluate('document.querySelector(".issue-stop-reason").getBoundingClientRect().height > 0'), true, '具体原因默认可见');
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${locale} 分支名不溢出`);
  }
  for (const [kind, expected] of [['environment', '环境准备失败'], ['budget', '达到止损上限'], ['paused', '系统暂停'], ['clarify', '必要信息'], ['blocked', '需要外部处理']]) {
    await evaluate(`window.showScenario('${kind}')`);
    await until(() => evaluate(`document.querySelector('.issue-stop').innerText.includes('${expected}')`));
  }
  await evaluate("window.showScenario('validation')");
  await until(() => evaluate('document.querySelector(".issue-stop strong").textContent.includes("验收失败")'));
  await evaluate("document.querySelector('.issue-stop summary').focus()");
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await evaluate('document.querySelector(".issue-stop details").open'), true, 'Enter 展开技术详情');
  await evaluate('document.querySelector(".issue-stop button").click()');
  await until(() => evaluate('document.querySelector("[role=dialog]")?.innerText.includes("original stdout")'));
  assert.match(await evaluate('document.querySelector("[role=dialog]").innerText'), /执行器输出已截断/);
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => evaluate('!document.querySelector("[role=dialog]")'));
  assert.equal(await evaluate('document.activeElement === document.querySelector(".issue-stop button")'), true, 'Escape 关闭并恢复焦点');
  await evaluate("window.showRecovery('paused')");
  await until(() => evaluate('!!document.querySelector("form.blocked-recovery")'));
  assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'), false, '暂停可直接恢复');
  assert.match(await evaluate('document.querySelector("[role=dialog]").innerText'), /恢复暂停任务/);
  assert.doesNotMatch(await evaluate('document.querySelector("[role=dialog]").innerText'), /解除阻塞|执行受阻原因|提交意见并继续运行/);
  await evaluate('document.querySelector("button[type=submit]").click()');
  assert.equal(await evaluate('window.recoverySubmitted'), 1);
  await evaluate("window.showRecovery('blocked')");
  await until(() => evaluate('document.querySelector("[role=dialog]")?.innerText.includes("解除阻塞")'));
  assert.equal(await evaluate('document.querySelector("button[type=submit]").disabled'), true, '外部受阻仍需解除方法');
  await evaluate("window.showScenario('validation')");
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await evaluate("window.showScenario('branch','zh-Hans')");
  await evaluate('document.querySelector(".issue-stop button.primary").click()');
  await until(()=>evaluate('document.querySelector(".incident-message")?.textContent.includes("codex/prototype")'));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'故障会话手机布局不溢出');
  assert.equal(await evaluate('document.querySelector(".incident-footer button.primary").disabled'),true,'未填写处理说明不能恢复');
  await evaluate(`{const e=document.querySelector('.incident-composer textarea');e.value='我已保留代码，请复查';e.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await cdp('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
  await until(()=>evaluate('!document.querySelector(".incident-dialog")'));
  assert.equal(await evaluate('document.activeElement===document.querySelector(".issue-stop button.primary")'),true,'关闭故障弹窗恢复入口焦点');
  await evaluate('document.querySelector(".issue-stop button.primary").click()');
  await until(()=>evaluate('document.querySelector(".incident-composer textarea")?.value==="我已保留代码，请复查"'));
  await evaluate('document.querySelector(".incident-composer button").click()');
  await until(()=>evaluate('!!document.querySelector(".incident-dialog [role=alert]")'));
  await until(()=>evaluate('document.querySelector(".incident-composer textarea")?.value===""'));
  const stats=await(await fetch(server.resolvedUrls.local[0]+'__incident-stats')).json();
  assert.equal(stats.initialAnalyses,1,'重开不重复分析');assert.equal(stats.sends,1,'响应丢失不重复发送');assert.equal(stats.resumes,0,'对话和关闭不恢复 issue');
  for(const locale of ['en','zh-Hans','zh-Hant','ja','ko','es','fr','de','pt-BR','ru']){
    await evaluate(`window.showScenario('branch','${locale}')`);
    await evaluate('document.querySelector(".issue-stop button.primary").click()');
    await until(()=>evaluate('!!document.querySelector(".incident-composer")'));
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,locale+' 故障会话无横向溢出');
    assert.equal(await evaluate('document.querySelector(".incident-dialog").scrollWidth <= document.querySelector(".incident-dialog").clientWidth'),true,locale+' 弹窗内部无溢出');
    assert.equal(await evaluate('[...document.querySelectorAll(".incident-disclosures details")].every(d=>!d.open)'),true,'详情与操作分别默认收起');
  }
  await evaluate("window.showScenario('branch','zh-Hans')");
  await evaluate('document.querySelector(".issue-stop button.primary").click()');
  await until(()=>evaluate('!!document.querySelector(".incident-footer input")'));
  await delay(500); // Capture after the existing modal entrance animation.
  const capture=await cdp('Page.captureScreenshot',{format:'png'});
  await writeFile('.private/incident-dialog-mobile.png',Buffer.from(capture.data,'base64'));
  assert.equal(await evaluate('document.querySelector(".incident-footer").getBoundingClientRect().bottom <= document.querySelector(".incident-dialog").getBoundingClientRect().bottom'),true,'人工恢复操作在手机弹窗内可见');
  await evaluate(`{const e=document.querySelector('.incident-footer input');e.value='已人工处理分支并核对现场';e.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await evaluate('document.querySelector(".incident-footer button.primary").click()');
  await until(()=>evaluate('document.querySelector(".incident-status")?.textContent.includes("等待恢复")'));
  assert.equal((await(await fetch(server.resolvedUrls.local[0]+'__incident-stats')).json()).resumes,1,'人工标记只提交一次恢复');
  assert.equal(await evaluate('!!document.querySelector(".incident-footer button.primary")'),false,'排队恢复时不再重复提供解决操作');
  for(const mode of ['analyzing','failed','stale','unknown','long','open-error','normal']){
    await fetch(server.resolvedUrls.local[0]+'__incident-mode?state='+mode);
    await evaluate('window.clearScenario()');
    await until(()=>evaluate('!document.querySelector(".issue-stop")'));
    await evaluate("window.showScenario('branch','zh-Hans')");
    await evaluate('document.querySelector(".issue-stop button.primary").click()');
    await until(()=>evaluate('!!document.querySelector(".incident-dialog")'));
    if(mode==='open-error'){
      await until(()=>evaluate('!!document.querySelector(".incident-feedback-error")'));
      assert.match(await evaluate('document.querySelector(".incident-state-pill").textContent'),/仍需处理/);
    }else{
      await until(()=>evaluate('!!document.querySelector(".incident-evidence")'));
      if(mode==='stale')assert.equal(await evaluate('!!document.querySelector(".incident-composer")'),false,'旧会话只读');
      if(mode==='failed')assert.match(await evaluate('document.querySelector(".incident-status").textContent'),/恢复未成功/);
      if(mode==='analyzing')assert.equal(await evaluate('!!document.querySelector(".incident-conversation-heading button")'),true,'分析中可停止');
      if(mode==='unknown')assert.equal(await evaluate('!!document.querySelector(".incident-verified")'),false,'缺少分支证据不展示已核实');
      if(mode==='long')assert.equal(await evaluate('document.querySelector(".incident-dialog").scrollWidth <= document.querySelector(".incident-dialog").clientWidth'),true,'长分支不溢出');
      if(mode==='normal'){
        const info=await evaluate('({top:document.querySelector(".incident-scroll").getBoundingClientRect().top,composer:document.querySelector(".incident-composer").getBoundingClientRect().bottom,footer:document.querySelector(".incident-footer").getBoundingClientRect().top})');
        assert.ok(info.composer<=info.footer+1,'对话输入和人工恢复分区不重叠');
        await evaluate('document.querySelector(".incident-scroll").scrollTop=0;document.querySelector(".incident-close").blur()');
        await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await delay(600);
        let shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile('.private/incident-redesign-mobile.png',Buffer.from(shot.data,'base64'));
        await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1040,deviceScaleFactor:1,mobile:false});await delay(600);
        shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile('.private/incident-redesign-desktop.png',Buffer.from(shot.data,'base64'));
        await cdp('Emulation.setDeviceMetricsOverride',{width:320,height:640,deviceScaleFactor:1,mobile:true});await delay(600);
        assert.equal(await evaluate('document.querySelector(".incident-dialog").scrollWidth <= document.querySelector(".incident-dialog").clientWidth'),true,'320px 窄屏无横向溢出');
        assert.equal(await evaluate('document.querySelector(".incident-footer").getBoundingClientRect().bottom<=innerHeight+1'),true,'窄屏恢复操作可见');
      }
    }
  }
  await fetch(server.resolvedUrls.local[0]+'__incident-mode?state=history');
  await evaluate('window.clearScenario()');await until(()=>evaluate('!document.querySelector(".issue-stop")'));
  await evaluate("window.showScenario('branch','zh-Hans')");await evaluate('document.querySelector(".issue-stop button.primary").click()');
  await until(()=>evaluate('document.querySelectorAll(".incident-message").length>10'));
  await evaluate('const e=document.querySelector(".incident-scroll");e.scrollTop=200;e.dispatchEvent(new Event("scroll"))');
  const reading=await evaluate('document.querySelector(".incident-scroll").scrollTop');
  await fetch(server.resolvedUrls.local[0]+'__incident-mode?state=append');
  await until(()=>evaluate('document.querySelector(".incident-messages").textContent.includes("A new reply arrived")'));
  assert.equal(await evaluate('document.querySelector(".incident-scroll").scrollTop'),reading,'阅读历史时新回复不抢滚动位置');
  await evaluate('document.querySelector(".incident-close").focus()');
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,modifiers:8});
  assert.equal(await evaluate('document.querySelector(".incident-footer").contains(document.activeElement)'),true,'Shift+Tab 在弹窗内循环');
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
  assert.equal(await evaluate('document.activeElement===document.querySelector(".incident-close")'),true,'Tab 返回顶部关闭按钮');
  console.log('通过：原因/对话/人工恢复分区、长分支、分析/恢复失败/只读/未知原因/启动失败状态、十语言内部布局、320px 窄屏');
  console.log('通过：故障独立弹窗自动分析、关闭重开保留草稿、消息响应丢失后核对、无自动恢复、人工标记排队、十语言手机布局和焦点');
  console.log('通过：十语言手机布局、六种停止说明、详情键盘展开、完整诊断、截断标记、Escape 与焦点恢复、暂停和受阻恢复动作、桌面布局');
} finally {
  ws?.close(); chrome?.kill(); if (chrome) { await chrome.exited; const err = await chromeErrors; if(chrome.exitCode!==0 && chrome.exitCode!==143) console.error(err.slice(-2500)); }
  await server.close(); await rm(dir, { recursive: true, force: true });
  if (socketDir && dirname(socketDir) === dir && basename(socketDir).startsWith('com.google.Chrome.')) await rm(socketDir, { recursive: true, force: true });
}
