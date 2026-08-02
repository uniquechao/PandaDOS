/**
 * core/daily-greeting —— 项目页欢迎卡的「每日欢迎语」（每用户按本地日期各一条，驱动大模型 生成）。
 *
 * 语义：GET /api/greeting 惰性生成——命中 (user_id, 今天) 直接返回缓存；未命中调 驱动大模型 生成
 * 一句 ≤GREETING_MAX_CHARS 字的中文欢迎语，落 daily_greeting 表（010 迁移）。LLM 失败返回 null，
 * 交上层回退静态文案（前端仍显示 '今天也顺顺利利 ✨'）。
 *
 * 「今天」用本地日切（DEFAULT_TZ=Asia/Shanghai）——直接 new Date(...).toISOString() 会按 UTC 取日，
 * 凌晨 0–8 点会错切到前一天（见 v2-session-reclaim 的 bun UTC 坑），故用 Intl 指定时区取日键。
 *
 * 与 readme-summary 同范式：buildPrompt → llm.chat → 按 Unicode 码点截断 → 落库。
 */
import type { Database } from 'bun:sqlite';
import type { LlmClient, LlmMessage } from '../agents/llm';
import type { SupportedLocale } from '../../shared/i18n/locales';
import { outputLanguageInstruction, promptLanguage } from '../agents/prompts/language';

/** 欢迎语字数上限（需求「20 字左右」；留少量余量，按 Unicode 码点截，防 emoji 腰斩） */
export const GREETING_MAX_CHARS = 24;

/** 默认时区：日切按东八区（生产部署地） */
export const DEFAULT_TZ = 'Asia/Shanghai';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/**
 * 指定时区下的日期键 'YYYY-MM-DD'。用 Intl.formatToParts（不依赖 locale 拼接顺序），
 * 避开 Date UTC 取日在凌晨错切前一天的问题。
 */
export function localDay(now: number, tz: string = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 由日期键推星期（用 UTC 构造避免时区偏移；纯展示用，不参与日切判断） */
function weekdayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return '';
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? '';
}

/** 生成欢迎语的提示词（纯文本，不用 jsonMode）；带日期/星期让每天自然不同 */
export function buildGreetingPrompt(
  username: string,
  day: string,
  locale: SupportedLocale = 'zh-Hans',
): LlmMessage[] {
  const wd = weekdayLabel(day);
  if (promptLanguage(locale) === 'en') {
    return [
      {
        role: 'system',
        content: `Write one warm, upbeat daily welcome sentence for a software project user. Return only the sentence with no title, quotes, or Markdown.\n${outputLanguageInstruction(locale)}`,
      },
      {
        role: 'user',
        content: `Date: ${day}. User name: ${username}. Write no more than ${GREETING_MAX_CHARS} characters and vary it naturally from day to day.`,
      },
    ];
  }
  return [
    {
      role: 'system',
      content:
        `你是暖心的项目助理，为用户写每天的欢迎语。只输出一句欢迎语正文，不要标题、引号、markdown 或任何多余说明。\n${outputLanguageInstruction(locale)}`,
    },
    {
      role: 'user',
      content:
        `今天是 ${day}${wd ? `（${wd}）` : ''}。请为用户「${username}」写一句 20 字以内的中文欢迎语，` +
        '语气温暖、积极、鼓励，每天都不一样，可自然融入用户名或今天的日期/星期。只回一句话。',
    },
  ];
}

/** 清洗 LLM 回复：取首个非空行、去掉包裹引号 */
function sanitize(raw: string): string {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line
    .replace(/^["'「『“‘]+/, '')
    .replace(/["'」』”’]+$/, '')
    .trim();
}

/** 截到字数上限（按 Unicode 码点，防 emoji 腰斩） */
export function truncateGreeting(text: string): string {
  const points = [...text];
  return points.length > GREETING_MAX_CHARS ? points.slice(0, GREETING_MAX_CHARS).join('') : text;
}

/** 调 LLM 生成一句欢迎语并清洗；空回答抛错（交上层按失败回退） */
export async function generateDailyGreeting(
  llm: LlmClient,
  username: string,
  day: string,
  locale: SupportedLocale = 'zh-Hans',
): Promise<string> {
  const r = await llm.chat(buildGreetingPrompt(username, day, locale));
  const text = sanitize(r.content ?? '');
  if (!text) throw new Error('LLM 返回空欢迎语');
  return text;
}

export interface DailyGreetingDeps {
  db: Database;
  llm: LlmClient;
  /** 测试注入时钟（缺省 Date.now） */
  now?: () => number;
  /** 日切时区（缺省 Asia/Shanghai） */
  tz?: string;
}

/** helper 需要的最小用户信息（id 落库、username 喂提示词） */
export interface GreetingUser {
  id: number;
  username: string;
  locale?: SupportedLocale;
}

interface GreetingRow {
  text: string;
}

/**
 * 取（或按需生成）用户今天的欢迎语。
 * - 命中 (user_id, 今天) → 返回缓存；
 * - 未命中 → 调 驱动大模型 生成、截断、落库并返回；
 * - LLM 失败 / 空回答 → 返回 null（上层回退静态文案，不落库、下次仍会重试）。
 * INSERT OR IGNORE + 回读：并发下两个请求同时生成时以已落库的为准，不重复覆盖。
 */
export async function getOrCreateDailyGreeting(
  deps: DailyGreetingDeps,
  user: GreetingUser,
): Promise<string | null> {
  const { db, llm } = deps;
  const now = deps.now ? deps.now() : Date.now();
  const day = localDay(now, deps.tz ?? DEFAULT_TZ);

  const existing = db
    .query<GreetingRow, [number, string]>('SELECT text FROM daily_greeting WHERE user_id = ? AND day = ?')
    .get(user.id, day);
  if (existing) return existing.text;

  let text: string;
  try {
    text = truncateGreeting(await generateDailyGreeting(llm, user.username, day, user.locale));
  } catch {
    return null;
  }
  if (!text) return null;

  db.query('INSERT OR IGNORE INTO daily_greeting (user_id, day, text, created_ts) VALUES (?, ?, ?, ?)').run(
    user.id,
    day,
    text,
    now,
  );
  const stored = db
    .query<GreetingRow, [number, string]>('SELECT text FROM daily_greeting WHERE user_id = ? AND day = ?')
    .get(user.id, day);
  return stored?.text ?? text;
}
