/**
 * core/issue-id —— 新 issue 编号生成器（#307）。格式定义见 `shared/issue-id.ts`。
 *
 * `YYYYMMDD`（本机本地日期）+ `-` + 4 位随机十六进制 + 本机 MAC 后 3 位十六进制。
 * 本机撞号由调用方（`IssueStore.create*`）捕获主键冲突后重新生成；跨实例撞号由同步导入端换号。
 */
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { IssueId } from '../../shared/issue-id';

export type { IssueId } from '../../shared/issue-id';
export { isIssueId, parseIssueId, compareIssueIds, ISSUE_ID_SOURCE } from '../../shared/issue-id';

let cachedMachineSuffix: string | null = null;

/** 本机第一块非回环、非全零网卡 MAC 的后 3 位十六进制；取不到时用进程级随机值兜底。 */
export function machineSuffix(): string {
  if (cachedMachineSuffix) return cachedMachineSuffix;
  let suffix: string | null = null;
  try {
    const all = Object.entries(networkInterfaces())
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([, list]) => list ?? []);
    const mac = all.find((i) => !i.internal && i.mac && !/^(00:){5}00$/.test(i.mac))?.mac;
    if (mac) suffix = mac.replace(/[^0-9a-f]/gi, '').toLowerCase().slice(-3);
  } catch {
    suffix = null;
  }
  cachedMachineSuffix = suffix && suffix.length === 3 ? suffix : randomBytes(2).toString('hex').slice(-3);
  return cachedMachineSuffix;
}

/** 本地日期 YYYYMMDD。 */
function localDate(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export interface IssueIdOptions {
  now?: Date;
  /** 覆盖 4 位随机段（测试用） */
  random?: string;
  /** 覆盖 3 位机器段（测试用） */
  machine?: string;
}

/** 生成一个新的 issue 编号。 */
export function newIssueId(opts: IssueIdOptions = {}): IssueId {
  const random = opts.random ?? randomBytes(2).toString('hex');
  return `${localDate(opts.now ?? new Date())}-${random}${opts.machine ?? machineSuffix()}`;
}

/** SQLite 主键 / 唯一约束冲突。 */
export function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed: issues\.id|PRIMARY KEY/i.test(msg);
}

/** 以新编号执行插入；本机撞号（主键冲突）时重新生成，最多重试 8 次。 */
export function withNewIssueId<T>(insert: (id: IssueId) => T, gen: () => IssueId = newIssueId): T {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return insert(gen());
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
