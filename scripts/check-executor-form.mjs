/**
 * 执行机真实浏览器回归：仅启动临时 Vite，所有 API 均拦截，不访问服务或执行机。
 * bun scripts/check-executor-form.mjs
 * 可用 PLAYWRIGHT_MODULE 指定 playwright-core 模块路径，CHROMIUM_PATH 指定浏览器。
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { resolve } from 'node:path';

// 轮次 TMPDIR 可能超出 Chromium Unix socket 限制，临时产物留在项目短路径。
const previousTmpdir = process.env.TMPDIR;
await mkdir('.private', { recursive: true });
process.env.TMPDIR = resolve('.private');

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const server = await createServer({
  root: 'ui', configFile: 'ui/vite.config.ts',
  server: { host: '127.0.0.1', port: 0, open: false },
});
let browser;
let passed = 0;
const fixture = {
  id: 7, name: '回归执行机', host: '', port: 22, sshUser: 'root', keyRef: '',
  workspaceRoot: '/original/workspace', claudeDir: '/original/claude', codexDir: '/original/codex',
  supportsClaude: true, supportsCodex: true, capabilitiesCheckedTs: null,
  isSystemLocal: false, status: 'online',
};
const detection = {
  checkedTs: 123, workspaceSuggestion: '/detected/workspace', warnings: [],
  agents: {
    claude: { commandFound: true, stateDirFound: true, suggestedDir: '/detected/claude' },
    codex: { commandFound: true, stateDirFound: true, suggestedDir: '/detected/codex' },
  },
};
const labels = { workspaceRoot: '工作区根目录', claudeDir: 'Claude 项目目录', codexDir: 'Codex 会话目录' };
const paths = Object.keys(labels);

async function scenario(width, mode, title, run) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const saves = [];
  const errors = [];
  const state = { detection, failDetection: false, waitDetection: null };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = [];
    if (path.endsWith('/detect')) {
      if (state.waitDetection) await state.waitDetection;
      if (state.failDetection) {
        await route.fulfill({ status: 502, json: { ok: false, error: '检测连接不可用' } });
        return;
      }
      body = { ok: true, detection: state.detection };
    } else if (/\/api\/admin\/executors(?:\/7)?$/.test(path)) {
      if (request.method() === 'GET') body = mode === 'edit' ? [fixture] : [];
      else {
        saves.push({ method: request.method(), path, body: request.postDataJSON() });
        body = { ok: true };
      }
    } else if (path === '/api/me') {
      body = { id: 1, username: '回归用户', role: 'admin', locale: 'zh-Hans', timezone: 'UTC', detectedTimezone: 'UTC' };
    } else if (path === '/api/projects/summary') body = { projects: {} };
    else if (path === '/api/llm-status') body = { configured: true };
    else if (path === '/api/me/settings') body = { ok: true };
    await route.fulfill({ json: body });
  });
  try {
    await page.goto(`${server.resolvedUrls.local[0]}#/admin`);
    await page.getByRole('button', { name: '执行器', exact: true }).click();
    await page.getByRole('button', { name: mode === 'edit' ? '编辑' : '＋ 注册执行器', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const field = key => dialog.getByRole('textbox', { name: labels[key], exact: true });
    const agent = name => dialog.getByRole('checkbox', { name: name === 'claude' ? 'Claude Code' : 'OpenAI Codex' });
    const save = dialog.getByRole('button', { name: '保存', exact: true });
    const detect = dialog.getByRole('button', { name: '自动检测', exact: true });
    if (mode === 'new') await dialog.locator('input[placeholder="local-1"]').fill('回归执行机');
    await run({ page, dialog, field, agent, save, detect, saves, state });
    assert.deepEqual(errors, [], '浏览器运行无异常');
    passed++;
    console.log(`通过：${width}px ${mode} ${title}`);
  } finally {
    await context.close();
  }
}

async function saved(dialog, saves, mode) {
  await dialog.waitFor({ state: 'detached' });
  assert.equal(saves.length, 1, '仅保存一次');
  assert.equal(saves[0].method, mode === 'new' ? 'POST' : 'PATCH');
  assert.equal(saves[0].path, mode === 'new' ? '/api/admin/executors' : '/api/admin/executors/7');
  return saves[0].body;
}

try {
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--no-sandbox'],
  });
  for (const width of [1280, 390]) for (const mode of ['new', 'edit']) {
    for (const enabled of [['claude'], ['codex'], ['claude', 'codex']]) {
      await scenario(width, mode, `手动注册/编辑 ${enabled.join('+')}`, async ({ page, dialog, field, agent, save, saves }) => {
        assert.equal(await dialog.locator('details').getAttribute('open'), '', '目录默认展开');
        for (const name of ['claude', 'codex']) await agent(name).setChecked(enabled.includes(name));
        await field('workspaceRoot').fill('/manual/workspace');
        for (const name of ['claude', 'codex']) {
          if (enabled.includes(name)) {
            assert.equal(await field(`${name}Dir`).isVisible(), true);
            await field(`${name}Dir`).fill(`/manual/${name}`);
          } else assert.equal(await field(`${name}Dir`).count(), 0, '未启用目录不参与必填');
        }
        // 从目录通过真实 Tab 导航到保存按钮，以 Enter 激活。
        await field(`${enabled.at(-1)}Dir`).focus();
        for (let n = 0; n < 12 && !await save.evaluate(el => el === document.activeElement); n++) await page.keyboard.press('Tab');
        assert.equal(await save.evaluate(el => el === document.activeElement), true, '键盘可达保存');
        await page.keyboard.press('Enter');
        const body = await saved(dialog, saves, mode);
        assert.equal(body.capabilitiesCheckedTs, null, '手动配置无需检测');
        assert.equal(body.workspaceRoot, '/manual/workspace');
        for (const name of ['claude', 'codex']) {
          assert.equal(body[`supports${name === 'claude' ? 'Claude' : 'Codex'}`], enabled.includes(name));
          if (enabled.includes(name)) assert.equal(body[`${name}Dir`], `/manual/${name}`);
        }
      });
    }
    await scenario(width, mode, '折叠后依次定位、空白拦截、重新启用展开', async ({ page, dialog, field, agent, save, saves }) => {
      await agent('claude').check();
      await agent('codex').check();
      for (const key of paths) await field(key).fill('   ');
      const summary = dialog.locator('summary');
      await summary.focus();
      await page.keyboard.press('Enter');
      assert.equal(await field('claudeDir').isVisible(), false, '键盘可折叠目录');
      for (const key of paths) {
        await save.click();
        await page.waitForFunction(key => document.activeElement?.getAttribute('name') === key, key);
        assert.equal(saves.length, 0, '缺失目录不会提交');
        assert.equal(await field(key).getAttribute('aria-invalid'), 'true');
        assert.match(await dialog.getByRole('alert').innerText(), new RegExp(labels[key]));
        assert.match(await dialog.getByRole('alert').innerText(), /绝对路径.*选择目录/);
        await field(key).fill(`/manual/${key}`);
      }
      await summary.click();
      await agent('codex').uncheck();
      await agent('codex').check();
      assert.equal(await field('codexDir').isVisible(), true, '重新启用后展开目录');
      assert.equal(await field('codexDir').inputValue(), '/manual/codexDir');
      assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth), true, '手机无横向溢出');
      if (width === 390 && mode === 'new') {
        await mkdir('.private/executor-form', { recursive: true });
        await page.screenshot({ path: '.private/executor-form/390px.png', fullPage: true });
      }
      await save.click();
      await saved(dialog, saves, mode);
    });
    await scenario(width, mode, '检测补空值、异步期间输入及重复检测逐字保留', async ({ page, dialog, field, agent, detect, save, saves, state }) => {
      await agent('claude').check();
      await agent('codex').check();
      for (const key of paths) await field(key).fill('  ');
      let release;
      state.waitDetection = new Promise(resolve => { release = resolve; });
      const requested = page.waitForRequest('**/detect');
      await detect.click();
      await requested;
      // 检测请求发出后继续手填，响应不得使用旧表单快照覆盖。
      const literal = '/手填/目录 空格/$HOME/"原样"';
      await field('claudeDir').fill(literal);
      release();
      await detect.waitFor({ state: 'visible' });
      assert.equal(await field('workspaceRoot').inputValue(), '/detected/workspace');
      assert.equal(await field('claudeDir').inputValue(), literal);
      assert.equal(await field('codexDir').inputValue(), '/detected/codex');
      for (const key of paths) await field(key).fill(`${literal}/${key}`);
      state.waitDetection = null;
      await detect.click();
      await detect.waitFor({ state: 'visible' });
      for (const key of paths) assert.equal(await field(key).inputValue(), `${literal}/${key}`);
      await save.click();
      const body = await saved(dialog, saves, mode);
      for (const key of paths) assert.equal(body[key], `${literal}/${key}`);
      assert.equal(body.capabilitiesCheckedTs, 123);
      assert.equal(body.supportsClaude && body.supportsCodex, true);
    });
    await scenario(width, mode, '检测无建议、折叠后检测启用新代理仍可手填', async ({ dialog, field, agent, detect, save, saves, state }) => {
      await agent('claude').check();
      await agent('codex').check();
      for (const key of paths) await field(key).fill('');
      await agent('codex').uncheck();
      await dialog.locator('summary').click();
      state.detection = {
        ...detection, workspaceSuggestion: null,
        agents: {
          claude: { commandFound: true, stateDirFound: false, suggestedDir: null },
          codex: { commandFound: true, stateDirFound: false, suggestedDir: null },
        },
      };
      await detect.click();
      await detect.waitFor({ state: 'visible' });
      for (const key of paths) {
        assert.equal(await field(key).isVisible(), true, '检测新启用代理的目录可见');
        assert.equal(await field(key).inputValue(), '', '无建议不编造路径');
        await field(key).fill(`/manual/${key}`);
      }
      await save.click();
      await saved(dialog, saves, mode);
    });
    await scenario(width, mode, '检测失败后保留手动入口并保存', async ({ dialog, field, agent, detect, save, saves, state }) => {
      await agent('claude').check();
      await agent('codex').check();
      for (const key of paths) await field(key).fill(`/manual/${key}`);
      state.failDetection = true;
      await detect.click();
      await dialog.locator('.err').waitFor();
      for (const key of paths) {
        assert.equal(await field(key).isEnabled(), true);
        assert.equal(await field(key).inputValue(), `/manual/${key}`);
      }
      assert.equal(await dialog.getByRole('button', { name: '选择目录', exact: true }).first().isEnabled(), true);
      await field('codexDir').fill('/manual/after-failure');
      await save.click();
      const body = await saved(dialog, saves, mode);
      assert.equal(body.codexDir, '/manual/after-failure');
      assert.equal(body.capabilitiesCheckedTs, null);
    });
  }
  console.log(`执行机交互回归完成：${passed} 项通过`);
} finally {
  await browser?.close();
  await server.close();
  if (previousTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmpdir;
}
