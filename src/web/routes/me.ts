/**
 * web/routes/me —— 「我的设定」自助读写（spec §7/§9-5；v1 /api/me/settings|memory 合并入库）。
 * persona/memory/autopilotDefault 单一真相源在 user_settings 表；
 * 截断护栏 persona 8000 / memory 50000 在 UserStore.putSettings 统一执行。
 * 只 export 路由定义，注册由集成步骤统一做。
 */
import type { SettingsPatch, UserStore } from '../../core/users';
import { isSupportedLocale, isValidTimeZone } from '../../../shared/i18n/locales';
import { json, type RouteDef } from '../middleware';

export interface MeRoutesDeps {
  users: UserStore;
}

/** 校验 PUT body：字段可缺省；提供了就必须是正确类型（不做隐式扭转，错给 400） */
function parseSettingsBody(
  b: unknown,
): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  if (typeof b !== 'object' || b === null) return { ok: false, error: 'body 必须是 JSON 对象' };
  const o = b as Record<string, unknown>;
  const patch: SettingsPatch = {};
  if ('persona' in o) {
    if (o.persona !== null && typeof o.persona !== 'string') return { ok: false, error: 'persona 必须是字符串或 null' };
    patch.persona = o.persona as string | null;
  }
  if ('memory' in o) {
    if (o.memory !== null && typeof o.memory !== 'string') return { ok: false, error: 'memory 必须是字符串或 null' };
    patch.memory = o.memory as string | null;
  }
  if ('autopilotDefault' in o) {
    if (typeof o.autopilotDefault !== 'boolean') return { ok: false, error: 'autopilotDefault 必须是布尔' };
    patch.autopilotDefault = o.autopilotDefault;
  }
  if ('notifyPref' in o) {
    if (o.notifyPref !== null && typeof o.notifyPref !== 'string') return { ok: false, error: 'notifyPref 必须是字符串或 null' };
    patch.notifyPref = o.notifyPref as string | null;
  }
  if ('locale' in o) {
    if (!isSupportedLocale(o.locale)) return { ok: false, error: 'locale 不受支持' };
    patch.locale = o.locale;
  }
  if ('timezone' in o) {
    if (o.timezone !== null && !isValidTimeZone(o.timezone)) {
      return { ok: false, error: 'timezone 必须是有效的 IANA 时区或 null' };
    }
    patch.timezone = o.timezone as string | null;
  }
  if ('detectedTimezone' in o) {
    if (o.detectedTimezone !== null && !isValidTimeZone(o.detectedTimezone)) {
      return { ok: false, error: 'detectedTimezone 必须是有效的 IANA 时区或 null' };
    }
    patch.detectedTimezone = o.detectedTimezone as string | null;
  }
  return { ok: true, patch };
}

export function meRoutes(deps: MeRoutesDeps): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/me/settings',
      auth: 'user',
      handler: ({ user }) => json(deps.users.getSettings(user!.id)),
    },
    {
      method: 'PUT',
      path: '/api/me/settings',
      auth: 'user',
      handler: async ({ req, user }) => {
        const parsed = parseSettingsBody(await req.json().catch(() => null));
        if (!parsed.ok) return json({ ok: false, error: parsed.error }, 400);
        const settings = deps.users.putSettings(user!.id, parsed.patch);
        return json({ ok: true, settings });
      },
    },
  ];
}

export { parseSettingsBody };
