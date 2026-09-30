/**
 * shared/issue-id —— issue 编号的格式与校验（#307），前后端共用的唯一维护点。
 *
 * - 新编号：`YYYYMMDD-` + 4 位随机十六进制 + 本机 MAC 后 3 位十六进制，如 `20260917-a3f9e4f`。
 *   日期前缀保证按时间排序，随机段 + 机器段保证多人多机协作时不撞号。
 * - 存量编号：迁移 074 之前的 issue 保留原数字（以文本存储，如 `307`），不回填。
 *
 * 生成器（需要读网卡）在 `src/core/issue-id.ts`；协议标记正则、路由、UI 只认这里的格式。
 */

export type IssueId = string;

/** 协议标记 / 路径里可嵌入的编号片段（不含锚点，不带捕获组）。 */
export const ISSUE_ID_SOURCE = '(?:\\d{8}-[0-9a-f]{7}|\\d+)';

const ISSUE_ID_RE = new RegExp(`^${ISSUE_ID_SOURCE}$`);

/** 是否为合法 issue 编号（新格式或存量数字）。 */
export function isIssueId(value: unknown): value is IssueId {
  return typeof value === 'string' && value.length <= 32 && ISSUE_ID_RE.test(value);
}

/** 宽松解析外部输入（URL 参数、JSON body、数字）；非法返回 null。 */
export function parseIssueId(value: unknown): IssueId | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/^#/, '').toLowerCase();
  if (!isIssueId(v)) return null;
  // 存量数字编号不接受前导 0，避免 `007` 与 `7` 指向同一条
  if (/^\d+$/.test(v) && (v.startsWith('0') || !Number.isSafeInteger(Number(v)))) return null;
  return v;
}

/** 按时间比较两个编号：存量数字编号早于所有新格式编号；同类内部各自按自然序。 */
export function compareIssueIds(a: IssueId, b: IssueId): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}
