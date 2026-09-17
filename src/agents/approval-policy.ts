/**
 * agents/approval-policy —— 自动批准的**全局规则策略集合**（唯一维护点，issue #91）。
 *
 * 为什么单独一个文件：弹窗自动批复的规则原先散在 approval.ts 的瀑布里，加一条就要动一次
 * 判定逻辑。这里把「规则」和「按什么顺序套用规则」拆开——本文件只声明规则，approval.ts
 * 只负责按序套用。以后要加规则、要把策略做成可配置（DB/管理页），改这里就够。
 *
 * **粒度刻意保持粗**：只描述「大类」（多选表单 / 信任弹窗 / 推荐标记 / 永不自动选），
 * 不枚举具体命令清单。细粒度的判断交给 LLM 分级那一层——枚举命令既列不全，又会在
 * 「列表里没有 = 危险」和「列表里没有 = 安全」之间反复横跳。
 */

// ---------- 规则本体（正则逐条注释；v1 平移的三条保持字节不变） ----------

/** 多选表单识别（v1 注释：selectOption 驱动不了且会死循环——真实死循环踩出来的疤） */
export const MULTI_SELECT_RE = /\[[ x✔✓]\]|[☒☐]|space to (toggle|select)/i;

/** trust 弹窗识别（对小写化的 context+options 全文匹配） */
export const TRUST_RE = /trust|信任/;

/** trust 弹窗里的同意项 */
export const TRUST_YES_RE = /yes|trust|信任|是/i;

/**
 * CLI 自带的「推荐」标记。**只认成对括号包起来的标记**，不认裸的「推荐」二字——
 * 「不推荐这么做」「推荐先看文档」这类正文里的词一旦命中就会点错项。
 * 覆盖 claude 的 `(recommended)`、中文全角 `（推荐）`、方括号 `[recommended]` 等写法。
 */
export const RECOMMENDED_RE = /[(（[【]\s*(recommended|推荐)\s*[)）\]】]/i;

/**
 * 任何自动层都不许选中的选项：点下去会**永久改变 CLI 行为**（以后同类弹窗不再出现，
 * 等于替主人把后续所有同类审批一次性放行）。这属于超出「自动点当前这一次」的授权范围，
 * 哪怕它被标了推荐也不自动点，落回 LLM 分级 / 人工。
 * 覆盖 don't-ask-again 与 always/总是 两种写法（「Yes, and don't ask again」「Allow always」）。
 */
export const NEVER_PICK_RE =
  /(don'?t\s+ask\s+(me\s+)?again|\balways\b|不再(询问|提示|问)|总是(允许|同意))/i;

/**
 * 危险·不可逆操作（LLM 分级不可用时的本地兜底判据，issue #91）。
 *
 * **有意只分大类、不枚举命令清单**：命令列表既列不全，也会在「表里没有=危险」和
 * 「表里没有=安全」之间反复横跳。这里只圈几类「一旦做错就回不去」的动作，命中即交人工。
 *
 * 该正则只在管家模型不可用时兜底，误判方向刻意不对称：**误判成危险只是多问主人一次
 * （安全），漏判才会误批（危险）**。正常审批必须交给管家结合完整语义判断，禁止把这组
 * 关键词提升为主判逻辑；简单临时目录清理由 `isSafeTemporaryRemoval` 明确排除。
 */
export const DANGER_RE = new RegExp(
  [
    /\brm\b|\brmdir\b|\bmkfs\b|\bdd\s+if=|删除|清空/, // 删文件/清数据
    /\bdrop\s+(table|database)\b|\btruncate\b|\bdelete\s+from\b/, // 删库
    /reset\s+--hard|--force\b|\bpush\s+-f\b|force-with-lease|filter-branch|\brebase\b|--amend/, // 改历史/强推
    /\bdeploy\b|\bpublish\b|\brelease\b|\bkubectl\b|\bhelm\b|\bterraform\b|上线|发布|部署/, // 部署上线
    /\bsecret\b|\bcredential\b|\bpassword\b|api[_-]?key|\.env\b|\bprod\b|生产|密钥/, // 生产配置/密钥
    /\bsudo\b|\bshutdown\b|\breboot\b|\bpoweroff\b|\bhalt\b|systemctl\s+(stop|restart|disable)|kill\s+-9|\bpkill\b/, // 系统级
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
);

/**
 * 同意项识别（本地兜底层用）。**必须从选项开头匹配**：不锚定的话「Don't allow」
 * 会因为含 allow 被当成同意项。
 *
 * 注意与 `core/agent-summary.pickAffirmative` 的区别，两者不能合并：那个是给一次性
 * 旁路会话「把挡路的菜单点掉」用的，认不出就退化到第 0 项；这个是在驱动会话里**代替
 * 主人授权**，认不出必须返回 -1 交人工，绝不能瞎点第 0 项。
 */
export const AFFIRM_RE =
  /^\s*(yes|y|ok|okay|proceed|continue|allow|approve|accept|confirm|同意|确认|继续|允许|接受|好)\b/i;

// ---------- 策略集合（对外唯一入口，approval.ts 只读这个对象） ----------

/**
 * 自动批准策略集合。键 = 大类，值 = 该类的判据。
 * 套用顺序**不在这里定**（顺序是 approval.ts 的瀑布，见那边的注释），这里只管「是什么」。
 */
export const APPROVAL_POLICY = {
  /** ① 交互式多选/表单 —— 永远升级人工，绝不自动点 */
  multiSelect: MULTI_SELECT_RE,
  /** ② 目录/文件信任弹窗 —— 直接同意；trust 命中后再用 trustYes 找同意项 */
  trust: TRUST_RE,
  trustYes: TRUST_YES_RE,
  /** ③ CLI 自带的推荐标记 —— 直接选推荐项，不用问 LLM */
  recommended: RECOMMENDED_RE,
  /** ④ 危险·不可逆大类 —— LLM 分级不可用时，命中即交人工 */
  danger: DANGER_RE,
  /** ④ 同意项 —— 未命中 danger 时，本地兜底选它 */
  affirm: AFFIRM_RE,
  /** 横切禁令：任何层都不许自动选中的选项 */
  neverPick: NEVER_PICK_RE,
} as const;

// ---------- 判定助手（纯函数，便于单测与复用） ----------

/** 多选/交互表单判定（正则 + 任一选项以 [ 开头，v1 双条件平移） */
export function isMultiSelectMenu(context: string, options: string[]): boolean {
  const joined = `${context} ${options.join(' ')}`;
  return APPROVAL_POLICY.multiSelect.test(joined) || options.some((o) => /^\s*\[/.test(o));
}

/** 该选项是否属于「永不自动选中」（don't ask again 一类） */
export function isNeverPick(option: string): boolean {
  return APPROVAL_POLICY.neverPick.test(option);
}

/**
 * 找出被 CLI 标为推荐的选项下标；无推荐项、或推荐项恰好属于 neverPick 时返回 -1。
 * 多个推荐项取第一个（CLI 不会这么排，真出现了按出现顺序也是最合理的选择）。
 */
export function pickRecommended(options: string[]): number {
  return options.findIndex((o) => APPROVAL_POLICY.recommended.test(o) && !isNeverPick(o));
}

/** 菜单是否涉及危险·不可逆操作（对 context + 全部选项一起判，命令通常在 context 里） */
export function isDangerousMenu(context: string, options: string[]): boolean {
  const text = `${context}\n${options.join('\n')}`;
  if (!isSafeTemporaryRemoval(text)) return APPROVAL_POLICY.danger.test(text);
  return APPROVAL_POLICY.danger.test(text.replace(/^\s*(?:\$\s*)?rm\b/im, ''));
}

/** 仅认可一条简单 rm 命令，且所有目标都位于系统或项目临时目录。复杂 shell 语法保守转人工。 */
function isSafeTemporaryRemoval(text: string): boolean {
  const commands = text.split('\n').map((line) => line.trim()).filter((line) => /^(?:\$\s*)?rm\b/i.test(line));
  if (commands.length !== 1) return false;
  const command = commands[0]!.replace(/^(?:\$\s*)?rm\s+/i, '');
  if (/[;&|`$()<>]/.test(command)) return false;
  const args = command.match(/(?:"[^"]*"|'[^']*'|\S+)/g) ?? [];
  const targets = args
    .filter((arg) => !arg.startsWith('-'))
    .map((arg) => arg.replace(/^(['"])(.*)\1$/, '$2').replace(/\/+$/, ''));
  return targets.length > 0 && targets.every((target) =>
    target === '/tmp' || target.startsWith('/tmp/') ||
    target === '.panda/tmp' || target.startsWith('.panda/tmp/') ||
    target.endsWith('/.panda/tmp') || target.includes('/.panda/tmp/'));
}

/**
 * 找出可安全自动选中的同意项下标；找不到返回 -1（**绝不退化到第 0 项**，见 AFFIRM_RE 注释）。
 * 排除 neverPick，因此「Yes」和「Yes, and don't ask again」并存时稳定选前者。
 */
export function pickSafeAffirmative(options: string[]): number {
  return options.findIndex((o) => APPROVAL_POLICY.affirm.test(o) && !isNeverPick(o));
}
