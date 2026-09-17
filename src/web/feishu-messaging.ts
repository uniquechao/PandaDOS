import type { Database } from 'bun:sqlite';
import type { FeishuChannel, FeishuConfig } from '../notify/feishu';
import { feishuOpenidOf, type NotifyRouter } from '../notify/router';
import type { FeishuLoginConfigStore } from './feishu-login-config';

export type MessagingChannel = Pick<FeishuChannel, 'name' | 'start' | 'stop' | 'status' | 'sendText' | 'sendCard' | 'sendGateCard' | 'verifyBinding'>;

/** One live bot per instance. Credential changes invalidate callbacks before replacement starts. */
export class FeishuMessaging {
  private channel: MessagingChannel | null = null;
  private activeKey = '';
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private failed = false;

  constructor(private readonly deps: {
    db: Database;
    config: FeishuLoginConfigStore;
    notify: NotifyRouter;
    defaultEnabled: boolean;
    create(config: FeishuConfig): MessagingChannel;
  }) {}

  enabled(): boolean {
    const row = this.deps.db.query<{ enabled: number }, []>('SELECT enabled FROM feishu_messaging_config WHERE id=1').get();
    return row ? row.enabled === 1 : this.deps.defaultEnabled;
  }

  private key(): string {
    const config = this.deps.config.load();
    return JSON.stringify([this.enabled(), config.appId, config.appSecret]);
  }

  get current(): MessagingChannel | null {
    return !this.closed && this.activeKey === this.key() ? this.channel : null;
  }

  status(userId: number) {
    const config = this.deps.config.load();
    const enabled = this.enabled();
    const configured = !!(config.appId && config.appSecret);
    const channel = this.current;
    const live = channel?.status();
    return {
      enabled, configured,
      state: !enabled ? 'disabled' : !configured ? 'unconfigured' : live?.state ?? (this.failed ? 'failed' : 'connecting'),
      lastReceivedAt: live?.lastReceivedAt ?? null, lastSentAt: live?.lastSentAt ?? null,
      lastError: live?.lastError ?? (this.failed ? 'connection_failed' : null),
      bound: !!feishuOpenidOf(this.deps.db, userId),
    };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.deps.db.query(`INSERT INTO feishu_messaging_config (id,enabled) VALUES (1,?)
      ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled`).run(Number(enabled));
    await this.refresh();
  }

  refresh(force = false): Promise<void> {
    const run = async () => {
      if (this.closed) return;
      const key = this.key();
      if (!force && this.activeKey === key && this.channel) return;
      this.deps.notify.unregister('feishu');
      const old = this.channel;
      this.channel = null;
      await old?.stop();
      if (this.closed) return;
      this.activeKey = key;
      this.failed = false;
      const config = this.deps.config.load();
      if (!this.enabled() || !config.appId || !config.appSecret) return;
      const channel = this.deps.create(config);
      this.channel = channel;
      try {
        await channel.start();
        if (this.closed || this.key() !== key) {
          this.channel = null;
          await channel.stop();
          return;
        }
        // Notifications already awaiting another recipient must not use stale app credentials.
        const active = () => {
          if (this.current !== channel) throw new Error('Feishu connection replaced');
        };
        this.deps.notify.register({
          name: channel.name,
          sendText: async (target, text) => { active(); await channel.sendText(target, text); },
          sendGateCard: async (target, event, i18n) => { active(); await channel.sendGateCard(target, event, i18n); },
        });
      } catch {
        this.channel = null;
        this.failed = true;
        await channel.stop();
      }
    };
    this.pending = this.pending.then(run, run);
    return this.pending;
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.deps.notify.unregister('feishu');
    await this.pending;
    const channel = this.channel;
    this.channel = null;
    await channel?.stop();
  }
}
