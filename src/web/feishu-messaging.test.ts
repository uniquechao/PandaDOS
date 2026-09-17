import { afterEach, expect, spyOn, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import { SessionStore } from '../core/sessions';
import { NotifyRouter } from '../notify/router';
import { FeishuLoginConfigStore } from './feishu-login-config';
import { FeishuMessaging, type MessagingChannel } from './feishu-messaging';
import { authDepsFromDb, createDispatcher } from './middleware';
import { feishuMessagingRoutes } from './routes/feishu-messaging';
import { feishuLoginConfigRoutes } from './routes/feishu-login-config';

const dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const path = '/api/admin/feishu-messaging';
function setup() {
  const db = openDb(':memory:'); dbs.push(db); migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const member = users.create('member');
  const config = new FeishuLoginConfigStore(db, null);
  const notify = new NotifyRouter(db);
  let fail = false;
  let release: Promise<void> | undefined;
  const channels: Array<MessagingChannel & { stopped: boolean; appId: string }> = [];
  const sent: Array<{ openid: string; userId: number }> = [];
  const messaging = new FeishuMessaging({ db, config, notify, defaultEnabled: false, create: (cfg) => {
    const channel = {
      name: 'feishu' as const, appId: cfg.appId, stopped: false,
      start: async () => { await release; if (fail) throw new Error('secret'); },
      stop: async () => { channel.stopped = true; },
      status: () => ({ state: 'connected' as const, lastReceivedAt: null, lastSentAt: null, lastError: null }),
      sendText: async () => {}, sendCard: async () => {}, sendGateCard: async () => {},
      verifyBinding: async (openid: string, userId = 0) => { sent.push({ openid, userId }); return !fail; },
    };
    channels.push(channel);
    return channel;
  } });
  const dispatch = createDispatcher([
    ...feishuMessagingRoutes(db, messaging),
    ...feishuLoginConfigRoutes(config, () => messaging.refresh()),
  ], authDepsFromDb(db, users, new SessionStore(db)));
  const call = (method: string, suffix = '', body?: unknown, token: string | null = admin.token, base = path) => dispatch(new Request(`https://panda.test${base}${suffix}`, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))!;
  const credentials = (appId = 'cli_company') => config.save(config.draft({ enabled: false, allowRegistration: true, appId, appSecret: 'secret', publicUrl: '' }));
  return { db, users, admin, member, config, notify, messaging, channels, sent, call, credentials,
    fail: () => { fail = true; }, block: (p: Promise<void>) => { release = p; } };
}

test('all management operations require admin; responses never include secrets', async () => {
  const s = setup();
  for (const [method, suffix] of [['GET', ''], ['PUT', ''], ['POST', '/reconnect'], ['POST', '/test']]) {
    expect((await s.call(method!, suffix, { enabled: true }, null)).status).toBe(401);
    expect((await s.call(method!, suffix, { enabled: true }, s.member.token)).status).toBe(403);
  }
  const response = await s.call('GET');
  expect(await response.json()).toMatchObject({ enabled: false, configured: false, state: 'disabled', bound: false });
  expect(s.channels).toHaveLength(0);
});

test('saved credentials alone keep channel off; enable validates and persists independently of login', async () => {
  const s = setup();
  expect((await s.call('PUT', '', { enabled: 'yes' })).status).toBe(400);
  expect((await s.call('PUT', '', { enabled: true })).status).toBe(400);
  s.credentials(); await s.messaging.refresh();
  expect(s.channels).toHaveLength(0);
  const response = await s.call('PUT', '', { enabled: true });
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain('secret');
  expect(JSON.parse(body)).toMatchObject({ enabled: true, configured: true, state: 'connected' });
  expect(s.config.load().enabled).toBe(false);
  expect(s.db.query<{enabled:number}, []>('SELECT enabled FROM feishu_messaging_config').get()?.enabled).toBe(1);
  await s.call('PUT', '', { enabled: false });
  expect(s.channels[0]!.stopped).toBe(true);
  expect(s.messaging.current).toBeNull();
  await s.messaging.stop();
});

test('credential save replaces live channel and disabling login alone does not reconnect', async () => {
  const s = setup(); s.credentials(); await s.messaging.setEnabled(true);
  const old = s.channels[0]!;
  await s.call('PUT', '', { enabled: false, allowRegistration: true, appId: 'cli_other', appSecret: 'new-secret', publicUrl: '' }, s.admin.token, '/api/admin/feishu-login-config');
  expect(old.stopped).toBe(true);
  expect(s.channels[1]!.appId).toBe('cli_other');
  await s.messaging.refresh();
  expect(s.channels).toHaveLength(2);
  await s.call('POST', '/reconnect');
  expect(s.channels[1]!.stopped).toBe(true);
  expect(s.channels).toHaveLength(3);
  await s.messaging.stop();
});

test('test message uses only authenticated administrator binding and accurately reports failure', async () => {
  const s = setup(); s.credentials(); await s.messaging.setEnabled(true);
  expect((await s.call('POST', '/test', { openid: 'ou_someone_else' })).status).toBe(400);
  s.users.setFeishuOpenid(s.admin.user.id, 'ou_admin');
  expect((await s.call('POST', '/test', { openid: 'ou_someone_else', userId: s.member.user.id })).status).toBe(200);
  expect(s.sent).toEqual([{ openid: 'ou_admin', userId: s.admin.user.id }]);
  s.fail();
  expect((await s.call('POST', '/test')).status).toBe(502);
  await s.messaging.setEnabled(false);
  expect((await s.call('POST', '/test')).status).toBe(503);
  await s.messaging.stop();
});

test('failed startup remains reviewable and cleanup runs', async () => {
  const s = setup(); s.credentials(); s.fail(); await s.messaging.setEnabled(true);
  expect(s.messaging.status(s.admin.user.id)).toMatchObject({ state: 'failed', lastError: 'connection_failed' });
  expect(s.channels[0]!.stopped).toBe(true);
  expect(s.messaging.current).toBeNull();
  await s.messaging.stop();
});

test('configuration changed during startup invalidates old channel and serialized refresh leaves one live instance', async () => {
  const s = setup(); s.credentials();
  let unblock!: () => void;
  s.block(new Promise<void>((resolve) => { unblock = resolve; }));
  const first = s.messaging.setEnabled(true);
  await Promise.resolve(); await Promise.resolve();
  s.credentials('cli_replacement');
  expect(s.messaging.current).toBeNull();
  const second = s.messaging.refresh();
  unblock(); await Promise.all([first, second]);
  expect(s.channels[0]!.stopped).toBe(true);
  expect(s.messaging.current).toBe(s.channels[1]!);
  const stopping = s.messaging.stop();
  expect(s.messaging.current).toBeNull();
  await stopping;
  expect(s.channels[1]!.stopped).toBe(true);
});

test('notification port rejects a replaced app before asynchronous connection cleanup', async () => {
  const s = setup(); s.credentials();
  const registered = spyOn(s.notify, 'register');
  await s.messaging.setEnabled(true);
  const port = registered.mock.calls[0]![0];
  s.credentials('cli_changed');
  await expect(port.sendText({ userId: s.admin.user.id, address: 'ou_admin' }, 'private')).rejects.toThrow('replaced');
  registered.mockRestore();
  await s.messaging.stop();
});

test('concurrent credential saves return matching configuration and callback URL', async () => {
  const s = setup(); s.credentials(); await s.messaging.setEnabled(true);
  let unblock!: () => void;
  s.block(new Promise<void>((resolve) => { unblock = resolve; }));
  const body = { enabled: true, allowRegistration: true, appSecret: 'secret' };
  const first = s.call('PUT', '', { ...body, appId: 'cli_first', publicUrl: 'https://first.example' }, s.admin.token, '/api/admin/feishu-login-config');
  await Promise.resolve(); await Promise.resolve();
  const second = s.call('PUT', '', { ...body, appId: 'cli_second', publicUrl: 'https://second.example' }, s.admin.token, '/api/admin/feishu-login-config');
  unblock();
  for (const response of await Promise.all([first, second])) {
    const { config } = await response.json();
    expect(config.callbackUrl).toBe(`${config.publicUrl}/api/feishu/oauth/callback`);
  }
  await s.messaging.stop();
});
