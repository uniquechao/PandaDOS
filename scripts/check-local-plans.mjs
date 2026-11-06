/** 隔离浏览器回归：验证计划分页、详情竞态与弹窗状态，不接触真实项目数据。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink, rm, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createServer } from 'vite';

const dir = resolve(await mkdtemp('.lp-'));
const fixture = `
import { h, render } from 'preact';
import { useState } from 'preact/hooks';
import { I18nProvider } from '/src/i18n/provider.tsx';
import { LocalPlansButton } from '/src/views/LocalPlans.tsx';
import { useRoute } from '/src/lib/router.ts';
import '/src/style.css';
localStorage.setItem('panda.locale', 'zh-Hans');
location.hash = '#/p/1/issue/original';
window.requests = [];
window.failPage = false;
window.failDetail = false;
window.failList = false;
const items = Array.from({length:45}, (_,i) => ({ id:'file:p'+i+'.md', planId:'p'+i, title:'本地计划 '+i+'：用于核对紧凑列表与超长标题的省略效果', status:'published', time:1793929011747-i*1000 }));
const detail = id => {
  const n = Number(id.match(/p(\\d+)/)[1]);
  const plan = {planId:'p'+n, title:items[n].title, issues:[{position:1,title:'关联任务 '+n,body:'原始正文\\n## 完整章节\\n'+('长正文内容 '.repeat(150)),acceptance:['独立验收'],dependsOn:[],module:null,agent:null}]};
  const execution = {planId:plan.planId,plan,title:plan.title,path:'.panda/plans/p'+n+'.md',createdTs:1793929011747,digest:'a'.repeat(64),effectsPending:false,lastError:null,issues:[{key:'1',issueId:'20261105-abcdef0',title:'不在当前任务列表页的关联任务',status:'done',blockers:[]}]};
  return {path:execution.path,digest:execution.digest,plan,error:null,execution,changed:false};
};
const realFetch = window.fetch;
window.fetch = async (url, opts={}) => {
  if (!String(url).startsWith('/api/projects/1/local-plans')) return realFetch(url, opts);
  window.requests.push({url:String(url),method:opts.method||'GET',body:opts.body});
  const u=new URL(url,location.origin);
  if(u.pathname.endsWith('/detail')) {
    const id=u.searchParams.get('id');
    await new Promise(r=>setTimeout(r,id==='file:p0.md'?450:30));
    if(window.failDetail) {window.failDetail=false;return Response.json({error:{code:'local_plans.unavailable',params:{},fallback:'失败'}},{status:503});}
    return Response.json(detail(id));
  }
  if(u.pathname.endsWith('/refresh')) return Response.json({ok:true});
  if(window.failList || (window.failPage && u.searchParams.get('page')==='2')) {
    window.failPage=false;window.failList=false;
    return Response.json({error:{code:'local_plans.unavailable',params:{},fallback:'失败'}},{status:503});
  }
  const filtered=items.filter(x=>(!u.searchParams.get('q') || x.title.includes(u.searchParams.get('q'))) && (!u.searchParams.get('status')||x.status===u.searchParams.get('status')));
  const page=Math.max(1,Math.min(Math.ceil(filtered.length/20)||1,Number(u.searchParams.get('page')||1)));
  return Response.json({items:filtered.slice((page-1)*20,page*20),page,pageSize:20,total:filtered.length});
};
function App(){const route=useRoute();const [filter,setFilter]=useState('保留原筛选');return h('main',{},[
  h('input',{id:'original-filter',value:filter,onInput:e=>setFilter(e.currentTarget.value)}),
  h('div',{id:'original-issue'},route.iid||'original'),
  h('div',{id:'original-scroll',style:'height:160px;overflow:auto'},h('div',{style:'height:1200px'},'原任务列表')),
  h(LocalPlansButton,{pid:1}),
]);}
render(h(I18nProvider,{me:null},h(App)),document.querySelector('#root'));
`;
const server = await createServer({ root:'ui',configFile:'ui/vite.config.ts', server:{host:'127.0.0.1',port:0}, optimizeDeps:{include:['preact','preact/hooks','preact/compat','preact/jsx-dev-runtime']},plugins:[{
  name:'local-plans-fixture',
  configureServer(server){server.middlewares.use('/__local_plans',(_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__plan_fixture.js"></script>');});},
  resolveId(id){if(id==='/__plan_fixture.js')return '\0local-plans-fixture';},
  load(id){if(id==='\0local-plans-fixture')return fixture;},
}]});
let chrome, ws, socketDir;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await delay(100); } throw Error('等待浏览器验证超时'); }
try {
  await server.listen();
  chrome = Bun.spawn([process.env.CHROMIUM_PATH || '/usr/bin/google-chrome', '--headless', '--no-proxy-server', '--disable-extensions', '--disable-background-networking', '--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdout: 'ignore', stderr: 'pipe', env: { ...process.env, TMPDIR: process.cwd() } });
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
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  ws.addEventListener('message', e => { const d=JSON.parse(e.data); if(d.method==='Runtime.exceptionThrown') console.error(JSON.stringify(d.params)); });
  await cdp('Page.navigate',{url:`http://127.0.0.1:${server.httpServer.address().port}/__local_plans`});
  await until(()=>evaluate('!!document.querySelector(".wb-list-action")'));
  const click = async text => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  await evaluate('document.querySelector("#original-scroll").scrollTop=420');
  await evaluate('document.querySelector(".wb-list-action").click()');
  await until(()=>evaluate('document.querySelectorAll(".local-plan-row").length===20'));
  assert.equal(await evaluate('window.requests.length'),1,'首次只加载第一页摘要');
  assert.equal(await evaluate('window.requests[0].url.includes("page=1")'),true);
  assert.match(await evaluate('document.querySelector(".local-plans-detail").innerText'),/选择一个计划查看详情/);
  assert.equal(await evaluate('!!document.querySelector(".local-plan-row.on")'),false);
  await mkdir('artifacts/20260101-000007c',{recursive:true});
  await writeFile('artifacts/20260101-000007c/initial.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await click('›');
  await until(()=>evaluate('document.querySelector(".local-plan-row").textContent.includes("本地计划 20")'));
  assert.equal(await evaluate('window.requests.length'),2,'翻页只请求新页摘要');
  await click('‹');
  await until(()=>evaluate('document.querySelector(".local-plan-row").textContent.includes("本地计划 0")'));
  await evaluate('document.querySelectorAll(".local-plan-row")[0].click()');
  await until(()=>evaluate('window.requests.some(r=>r.url.includes("/detail"))'));
  await evaluate('document.querySelectorAll(".local-plan-row")[1].click()');
  await until(()=>evaluate('document.querySelector(".local-plan-heading h2")?.textContent.includes("本地计划 1")'));
  await delay(550);
  assert.match(await evaluate('document.querySelector(".local-plan-heading h2").textContent'),/本地计划 1：/,'早请求不能覆盖当前详情');
  await evaluate('window.failPage=true');
  await click('›');
  await until(()=>evaluate('!!document.querySelector(".local-plans-sidebar [role=alert]")'));
  assert.match(await evaluate('document.querySelector(".local-plan-row").textContent'),/本地计划 0：/,'翻页失败保留原内容');
  assert.match(await evaluate('document.querySelector(".local-plans-pagination").textContent'),/第 1 \/ 3 页/,'翻页失败保留页码');
  await click('重试');
  await until(()=>evaluate('document.querySelector(".local-plan-row").textContent.includes("本地计划 20")'));
  assert.match(await evaluate('document.querySelector(".local-plan-heading h2").textContent'),/本地计划 1：/,'翻页保留已打开详情');
  await evaluate('window.failDetail=true;document.querySelectorAll(".local-plan-row")[2].click()');
  await until(()=>evaluate('!!document.querySelector(".local-plans-detail [role=alert]")'));
  await click('重试');
  await until(()=>evaluate('document.querySelector(".local-plan-heading h2")?.textContent.includes("本地计划 22")'));
  await click('计划内容');
  await until(()=>evaluate('document.querySelector(".local-plan-tasks")?.textContent.includes("完整章节")'));
  await evaluate(`document.querySelector('.local-plans-filters input').value='无匹配项';document.querySelector('.local-plans-filters input').dispatchEvent(new Event('input',{bubbles:true}))`);
  await until(()=>evaluate('document.querySelector(".local-plans-list").textContent.includes("没有符合条件的计划")'));
  assert.equal(await evaluate('new URL(window.requests.filter(r=>!r.url.includes("/detail")).at(-1).url,location.origin).searchParams.get("page")'),'1','搜索重置页码');
  await evaluate(`document.querySelector('.local-plans-filters input').value='';document.querySelector('.local-plans-filters input').dispatchEvent(new Event('input',{bubbles:true}))`);
  await until(()=>evaluate('document.querySelectorAll(".local-plan-row").length===20'));
  await mkdir('artifacts/20260101-000007c',{recursive:true});
  await writeFile('artifacts/20260101-000007c/desktop.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await click('执行进度');
  await evaluate('document.querySelectorAll(".local-plan-row")[1].click()');
  await until(()=>evaluate('document.querySelector(".local-plan-heading h2")?.textContent.includes("本地计划 1：")'));
  await writeFile('artifacts/20260101-000007c/desktop-progress.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('document.querySelector(".local-plan-progress a").click()');
  await until(()=>evaluate('!document.querySelector("[role=dialog]")'));
  assert.equal(await evaluate('location.hash'),'#/p/1/issue/20261105-abcdef0','关联页外任务回到原首页打开');
  assert.equal(await evaluate('document.querySelector("#original-filter").value'),'保留原筛选');
  assert.equal(await evaluate('document.querySelector("#original-scroll").scrollTop'),420);
  await evaluate('document.querySelector(".wb-list-action").click()');
  await until(()=>evaluate('document.querySelectorAll(".local-plan-row").length===20'));
  await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(()=>evaluate('!document.querySelector("[role=dialog]")'));
  assert.equal(await evaluate('document.activeElement===document.querySelector(".wb-list-action")'),true,'关闭恢复入口焦点');
  assert.equal(await evaluate('document.querySelector("#original-scroll").scrollTop'),420);
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate('window.failList=true;document.querySelector(".wb-list-action").click()');
  await until(()=>evaluate('!!document.querySelector(".local-plans-sidebar [role=alert]")'));
  await click('重试');
  await until(()=>evaluate('document.querySelectorAll(".local-plan-row").length===20'));
  await evaluate('document.querySelectorAll(".local-plan-row")[1].click()');
  await until(()=>evaluate('!!document.querySelector(".local-plan-heading h2")'));
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'窄屏不横向溢出');
  assert.equal(await evaluate('document.querySelector(".local-plans-modal").getBoundingClientRect().height<=innerHeight'),true);
  await writeFile('artifacts/20260101-000007c/mobile.png',Buffer.from((await cdp('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('document.querySelector(".local-plans-close").click()');
  await until(()=>evaluate('!document.querySelector("[role=dialog]")'));
  console.log('通过：首次与翻页仅摘要、点击按需详情、快速切换保护、列表与详情失败重试、失败保留页码、搜索归首页、正文预览、页外关联任务、Esc 与焦点和滚动保留、桌面及窄屏布局');
} finally {
  ws?.close(); chrome?.kill(); if (chrome) { await chrome.exited; const err = await new Response(chrome.stderr).text(); if (chrome.exitCode !== 0 && chrome.exitCode !== 143) console.error(err.slice(-1500)); }
  await server.close(); await rm(dir, { recursive: true, force: true });
  if (socketDir && dirname(socketDir) === process.cwd() && basename(socketDir).startsWith('com.google.Chrome.')) await rm(socketDir, { recursive: true, force: true });
}
