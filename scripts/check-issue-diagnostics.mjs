/** 隔离真实浏览器回归：只装载当前组件，模拟 API，不操作服务或 issue。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readlink, rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createServer } from 'vite';

const dir = resolve(await mkdtemp('.d-')); // 短路径避免 Chromium Unix socket 超长，独立目录防并发覆盖。
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
window.showScenario();
`;
const server = await createServer({ root: 'ui', configFile: 'ui/vite.config.ts', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { include: ['preact', 'preact/hooks', 'preact/compat', 'preact/jsx-dev-runtime'] }, plugins: [{
  name: 'diagnostic-fixture',
  configureServer(server) {
    server.middlewares.use('/__diagnostics', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<link rel="icon" href="data:,"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/__fixture.js"></script>'); });
    server.middlewares.use('/api/projects/1/issues/test/diagnostics', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ retainedOutput: true, events: [{ id: 10, kind: 'validation_diagnostic', ts: 1793704975718, dataJson: JSON.stringify({ argv: ['bun', 'test'], out: 'original stdout', err: '(fail) 真实失败名称\nError: expected 1', sourceTruncated: true }) }] }));
    });
  },
  resolveId(id) { if (id === '/__fixture.js') return '\0diagnostic-fixture'; },
  load(id) { if (id === '\0diagnostic-fixture') return fixture; },
}] });
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
  console.log('通过：十语言手机布局、六种停止说明、详情键盘展开、完整诊断、截断标记、Escape 与焦点恢复、暂停和受阻恢复动作、桌面布局');
} finally {
  ws?.close(); chrome?.kill(); if (chrome) { await chrome.exited; const err = await new Response(chrome.stderr).text(); if (chrome.exitCode !== 0 && chrome.exitCode !== 143) console.error(err.slice(-1500)); }
  await server.close(); await rm(dir, { recursive: true, force: true });
  if (socketDir && dirname(socketDir) === process.cwd() && basename(socketDir).startsWith('com.google.Chrome.')) await rm(socketDir, { recursive: true, force: true });
}
