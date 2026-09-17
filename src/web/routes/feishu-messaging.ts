import { feishuOpenidOf } from '../../notify/router';
import type { Database } from 'bun:sqlite';
import type { FeishuMessaging } from '../feishu-messaging';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

export function feishuMessagingRoutes(db: Database, messaging: FeishuMessaging): RouteDef[] {
  return [
    { method: 'GET', path: '/api/admin/feishu-messaging', auth: 'admin',
      handler: ({ user }) => json(messaging.status(user!.id)) },
    { method: 'PUT', path: '/api/admin/feishu-messaging', auth: 'admin',
      handler: async ({ req, user }) => {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.enabled !== 'boolean') {
          return json(apiError('feishu.messaging_invalid', 'Choose whether to enable messaging.', 400), 400);
        }
        if (body.enabled && !messaging.status(user!.id).configured) {
          return json(apiError('feishu.messaging_unconfigured', 'Save an App ID and secret first.', 400), 400);
        }
        await messaging.setEnabled(body.enabled);
        return json(messaging.status(user!.id));
      } },
    { method: 'POST', path: '/api/admin/feishu-messaging/reconnect', auth: 'admin',
      handler: async ({ user }) => {
        await messaging.refresh(true);
        return json(messaging.status(user!.id));
      } },
    { method: 'POST', path: '/api/admin/feishu-messaging/test', auth: 'admin',
      handler: async ({ user }) => {
        const channel = messaging.current;
        if (!channel) return json(apiError('feishu.messaging_unavailable', 'Enable and connect messaging first.', 503), 503);
        // The request cannot choose another recipient. Only the authenticated user's binding is used.
        const openid = feishuOpenidOf(db, user!.id);
        if (!openid) return json(apiError('feishu.messaging_unbound', 'Link your own Feishu account first.', 400), 400);
        const ok = await channel.verifyBinding(openid, user!.id);
        return ok ? json({ ok: true }) : json(apiError('feishu.messaging_send_failed', 'The test message could not be sent. Check bot permissions and app availability.', 502), 502);
      } },
  ];
}
