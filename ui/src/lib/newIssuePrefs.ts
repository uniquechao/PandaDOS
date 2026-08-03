/**
 * ui/lib/newIssuePrefs —— 新建 issue 表单的「记住上次选择」（存浏览器本地，按设备）。
 *
 * 目前只记自动批准档位（#115）：跟账号走会让「我在自己电脑上敢开全自动、在别人机器上不敢」
 * 这件事失控，所以明确按设备存（localStorage），一台机器一份，不同步。
 * 读侧对任何脏值/localStorage 不可用都退回 'medium' —— 新建表单必须能开出来，
 * 且回退到的是既有默认档位，绝不会因为存储损坏悄悄放宽成全自动。
 */
import type { AutoApproveLevel } from './types';

/** localStorage 键（按设备存，一个用户多设备各自记） */
export const NEW_ISSUE_AA_KEY = 'panda.newIssueAutoApprove';

/** 没记录时的默认档位 = 后端默认，也是现有审批管道行为 */
export const NEW_ISSUE_AA_DEFAULT: AutoApproveLevel = 'medium';

function parse(v: unknown): AutoApproveLevel | null {
  return v === 'cautious' || v === 'medium' || v === 'auto' ? v : null;
}

/** 读上次选的档位（无记录/脏值/隐私模式 → 'medium'） */
export function readNewIssueAutoApprove(): AutoApproveLevel {
  try {
    return parse(localStorage.getItem(NEW_ISSUE_AA_KEY)) ?? NEW_ISSUE_AA_DEFAULT;
  } catch {
    return NEW_ISSUE_AA_DEFAULT;
  }
}

/** 记下这次选的档位；非法值不落库（免得把脏值传给下一次），隐私模式/配额满静默降级 */
export function writeNewIssueAutoApprove(level: AutoApproveLevel): void {
  const v = parse(level);
  if (!v) return;
  try {
    localStorage.setItem(NEW_ISSUE_AA_KEY, v);
  } catch {
    /* 隐私模式 / 配额满：记不住而已，不挡建 issue */
  }
}
