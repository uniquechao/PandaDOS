/**
 * core/activity —— 用户活跃统计（013_user_message_counts；issue #102 admin 用户表统计列）。
 *
 * 两类口径：
 * - 任务数：issues.created_by 归属「谁提的算谁的」（生产存量全有值），今天 = created_ts 落在本地当日；
 *   取消/完成的 issue 一样计入（统计的是「提了多少」，不是「还剩多少」）。
 * - 消息数：库里没有消息表（消息正文只在执行机的 agent jsonl 里，且没有发送者归属），
 *   故由各发送入口注入成功后调 MessageCounter.bump 累计，按本地日分桶存 user_message_counts。
 *   计数从 013 上线时刻起算，历史不回填。
 *
 * 日切一律走本地时区（DEFAULT_TZ=Asia/Shanghai）：bun 无 TZ 环境变量时按 UTC 解析，
 * 直接拿 UTC 日期会让凌晨 0–8 点错切到前一天（见 daily-greeting 同款处理与 v2-session-reclaim 的坑）。
 */
import type { Database } from 'bun:sqlite';
import { DEFAULT_TZ, localDay } from './daily-greeting';

export { DEFAULT_TZ, localDay };

/**
 * 指定时区相对 UTC 的偏移（毫秒，东八区 = +8h）。用 Intl 把 now 格式化成该时区的墙钟，
 * 再按 UTC 重新组装相减——不依赖宿主 TZ，也不需要自己维护时区表。
 * 格式化只到秒，故减法前把 now 对齐到秒（真实偏移都是整分钟，结果精确）。
 */
function tzOffsetMs(now: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(now));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24, // 少数 ICU 版本把午夜格式化成 24 时
    get('minute'),
    get('second'),
  );
  return wall - (now - (((now % 1000) + 1000) % 1000));
}

/**
 * 该时刻所在「本地当日 0 点」的 epoch 毫秒（SQL 里按 created_ts >= dayStart 取今天）。
 * 与 localDay 同口径：localDay(localDayStartMs(t)) === localDay(t)。
 * 偏移取自 now 那一刻（Asia/Shanghai 无夏令时恒 +8；有夏令时的时区在切换当天可能差一小时，
 * 本项目日切只服务展示统计，可接受）。
 */
export function localDayStartMs(now: number, tz: string = DEFAULT_TZ): number {
  const offset = tzOffsetMs(now, tz);
  const dayStartWall = Math.floor((now + offset) / 86_400_000) * 86_400_000;
  return dayStartWall - offset;
}

/** 每用户统计（admin 用户表的 5 个统计列：最近使用时间在 users.last_seen_ts，不在这里） */
export interface UserActivityStats {
  userId: number;
  /** 今天创建的 issue 数（本地日切） */
  todayTasks: number;
  /** 累计创建的 issue 数 */
  totalTasks: number;
  /** 今天发出的消息数（本地日切） */
  todayMessages: number;
  /** 累计发出的消息数（013 上线后起算） */
  totalMessages: number;
}

export interface ActivityOpts {
  /** 注入时钟（测试用）；缺省 Date.now */
  now?: () => number;
  /** 日切时区；缺省 Asia/Shanghai */
  tz?: string;
}

/**
 * 计数入口的最小结构接口（MessageCounter 天然满足）：发送侧只需要 bump 这一个能力，
 * 依赖收窄到它，测试可用最简 stub，装配缺失时按可选依赖静默跳过。
 */
export interface MessageBumper {
  bump(userId: number, at?: number): void;
}

/** 用户发出的消息计数器：各发送入口注入成功后 bump 一次。 */
export class MessageCounter implements MessageBumper {
  private readonly now: () => number;
  private readonly tz: string;

  constructor(
    private readonly db: Database,
    opts: ActivityOpts = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.tz = opts.tz ?? DEFAULT_TZ;
  }

  /**
   * 给该用户当天计数 +1（无该用户的话外键会挡；调用方都是已鉴权用户，正常不会命中）。
   * at = 消息时刻（缺省当前时钟），只用来决定落在哪一天。
   */
  bump(userId: number, at: number = this.now()): void {
    this.db
      .query(
        `INSERT INTO user_message_counts (user_id, day, count) VALUES (?, ?, 1)
         ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`,
      )
      .run(userId, localDay(at, this.tz));
  }

  /** 单个用户的今天/累计消息数（无记录时全 0） */
  countsFor(userId: number): { today: number; total: number } {
    const r = this.db
      .query<{ today: number; total: number }, [string, number]>(
        `SELECT COALESCE(SUM(CASE WHEN day = ? THEN count END), 0) AS today,
                COALESCE(SUM(count), 0) AS total
           FROM user_message_counts WHERE user_id = ?`,
      )
      .get(localDay(this.now(), this.tz), userId);
    return { today: r?.today ?? 0, total: r?.total ?? 0 };
  }
}

interface StatsRow {
  user_id: number;
  today_tasks: number;
  total_tasks: number;
  today_messages: number;
  total_messages: number;
}

/**
 * 全体用户的活跃统计，按 user id 索引（admin 用户列表一次取齐，用户数是个位数，子查询足够）。
 * 没有任何任务/消息的用户也在结果里（全 0），调用方不用兜底。
 */
export function activityStatsByUser(
  db: Database,
  opts: ActivityOpts = {},
): Map<number, UserActivityStats> {
  const now = (opts.now ?? (() => Date.now()))();
  const tz = opts.tz ?? DEFAULT_TZ;
  const rows = db
    .query<StatsRow, [number, string]>(
      `SELECT u.id AS user_id,
              (SELECT COUNT(*) FROM issues i
                WHERE i.created_by = u.id AND i.created_ts >= ?) AS today_tasks,
              (SELECT COUNT(*) FROM issues i WHERE i.created_by = u.id) AS total_tasks,
              COALESCE((SELECT c.count FROM user_message_counts c
                         WHERE c.user_id = u.id AND c.day = ?), 0) AS today_messages,
              COALESCE((SELECT SUM(c.count) FROM user_message_counts c
                         WHERE c.user_id = u.id), 0) AS total_messages
         FROM users u ORDER BY u.id`,
    )
    .all(localDayStartMs(now, tz), localDay(now, tz));
  return new Map(
    rows.map((r) => [
      r.user_id,
      {
        userId: r.user_id,
        todayTasks: r.today_tasks,
        totalTasks: r.total_tasks,
        todayMessages: r.today_messages,
        totalMessages: r.total_messages,
      },
    ]),
  );
}
