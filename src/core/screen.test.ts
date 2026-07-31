import { describe, expect, test } from 'bun:test';
import {
  codexExitedToShell,
  detectSelection,
  isCodexUpdatePrompt,
  isMultiSelectOptions,
  selectionSig,
} from './screen';

// 注意：CC 真实渲染里选项行没有前导边框（评审 M5：「选项行不能有前导边框」是 detectSelection
// 的已知强耦合），说明行才带 │/⏺ 装饰。
const MENU = `
⏺ Bash(rm -rf node_modules)
│ Do you want to proceed?
│
 ❯ 1. Yes
   2. Yes, and don't ask again
   3. No, tell Claude what to do differently
`;

describe('detectSelection（v1 observer.ts:139-168 逐字节平移）', () => {
  test('识别菜单：options/cursorIndex/context', () => {
    const sel = detectSelection(MENU);
    expect(sel).not.toBeNull();
    expect(sel!.options).toEqual(['Yes', "Yes, and don't ask again", 'No, tell Claude what to do differently']);
    expect(sel!.cursorIndex).toBe(0);
    expect(sel!.context).toContain('Do you want to proceed?');
    // 装饰字符（│⏺ 等）被清洗出 context
    expect(sel!.context).not.toContain('│');
  });

  test('光标在第二项', () => {
    const pane = `问题\n  1. A\n❯ 2. B\n  3. C\n`;
    const sel = detectSelection(pane)!;
    expect(sel.cursorIndex).toBe(1);
    expect(sel.options).toEqual(['A', 'B', 'C']);
  });

  test('无 ❯ 编号锚点 → null（普通输出不误报）', () => {
    expect(detectSelection('1. 第一步\n2. 第二步\n只是列表')).toBeNull();
    expect(detectSelection('')).toBeNull();
    expect(detectSelection('❯ 提示符但没有编号')).toBeNull();
  });

  test('签名 = options|@cursorIndex（注入前核对用）', () => {
    const sel = detectSelection(MENU)!;
    expect(selectionSig(sel)).toBe("Yes|Yes, and don't ask again|No, tell Claude what to do differently@0");
  });

  test('Resume 菜单（真实抓屏）：相邻选项块照旧一次收全', () => {
    // 实抓自一条 1d19h 的 chat 会话；经典形态=选项行彼此相邻、以 Enter to confirm 页脚收尾。
    const pane = [
      '──────────────────────────────────────────────',
      '  This session is 1d 19h old and 108.9k tokens.',
      '',
      '  Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a',
      '  summary.',
      '',
      '  ❯ 1. Resume from summary (recommended)',
      '    2. Resume full session as-is',
      "    3. Don't ask me again",
      '',
      '  Enter to confirm · Esc to cancel',
    ].join('\n');
    const sel = detectSelection(pane)!;
    expect(sel.options).toEqual([
      'Resume from summary (recommended)',
      'Resume full session as-is',
      "Don't ask me again",
    ]);
    expect(sel.cursorIndex).toBe(0);
    expect(sel.context).toContain('We recommend resuming from a');
  });

  test('codex 菜单（› 光标，issue #48）：识别 options/cursorIndex', () => {
    const pane = `
  Allow command?
› 1. Yes, run it
  2. No, tell me what to do
`;
    const sel = detectSelection(pane)!;
    expect(sel.options).toEqual(['Yes, run it', 'No, tell me what to do']);
    expect(sel.cursorIndex).toBe(0);
    expect(sel.context).toContain('Allow command?');
  });

  test('codex 升级弹窗按菜单识别；composer 输入行（› 开头非编号）不误报', () => {
    const upd = `Update available! 0.144.6 -> 0.145.0\n› 1. Update now\n  2. Skip\nPress enter to continue\n`;
    const sel = detectSelection(upd)!;
    expect(sel.options).toEqual(['Update now', 'Skip']);
    expect(detectSelection('› Write tests for @filename\n  gpt-5.6 medium\n')).toBeNull();
    expect(detectSelection('› 提示符但没有编号')).toBeNull();
  });
});

/**
 * issue #94/#95 真实抓屏语料：Claude Code v2.1.220 的 AskUserQuestion 菜单
 * （tmux 114×38 实抓，逐字保留）。与经典权限弹窗的关键差别：
 * - 每个选项 label 下面跟 2 行中文说明 —— **选项行彼此不相邻**；
 * - 末尾两项是 CC 自带的 `4. Type something.` / `5. Chat about this`，
 *   且两者之间还夹一条横分隔线；
 * - 菜单以「Enter to select · ↑/↓ to navigate · Esc to cancel」页脚收尾。
 */
const ASK_MENU_CURSOR_FIRST = `──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ 盒子朝向

在你的应用场景中，这些盒子的朝向（如正面、侧面、背面等）是基本保持固定状态，还是需要根据用户交互或数据变化而动态改
变？

❯ 1. 朝向基本固定
     盒子在初始化后朝向保持不变，用户看到的视角始终相同。这种情况下可以用静态配置来定义每个盒子的初始朝向，不需要
     实现动态旋转或翻转的逻辑。适合展示用途或信息板场景。
  2. 每个盒子朝向都会变
     盒子的朝向会根据用户操作（如点击、拖拽）或实时数据更新而改变。这需要实现完整的状态管理、动画过渡效果和事件监
     听机制，确保朝向变化时界面能正确响应和重新渲染。
  3. 不确定，先按固定做
     目前还不确定最终需求，希望先实现一个基础版本，假设朝向是固定的。这样可以快速验证核心功能，后续根据实际需求再
     扩展为动态朝向功能。相对低风险的渐进式方案。
  4. Type something.
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

/** 同一菜单、光标按 ↓ 移到末项（实测 ↓×4 从第 1 项线性走到第 5 项，跨分隔线也照走） */
const ASK_MENU_CURSOR_LAST = ASK_MENU_CURSOR_FIRST.replace('❯ 1. 朝向基本固定', '  1. 朝向基本固定').replace(
  '  5. Chat about this',
  '❯ 5. Chat about this',
);

const ASK_OPTIONS = [
  '朝向基本固定',
  '每个盒子朝向都会变',
  '不确定，先按固定做',
  'Type something.',
  'Chat about this',
];

describe('detectSelection · AskUserQuestion 多行说明菜单（issue #94/#95）', () => {
  test('光标在首项：5 个选项全解析（旧实现在第一条说明行就停，只出 1 个）', () => {
    const sel = detectSelection(ASK_MENU_CURSOR_FIRST)!;
    expect(sel).not.toBeNull();
    expect(sel.options).toEqual(ASK_OPTIONS);
    expect(sel.cursorIndex).toBe(0);
  });

  test('光标在末项：选项顺序不变、cursorIndex 指到第 5 项（旧实现会退化成 ["Chat about this"]）', () => {
    const sel = detectSelection(ASK_MENU_CURSOR_LAST)!;
    expect(sel.options).toEqual(ASK_OPTIONS);
    expect(sel.cursorIndex).toBe(4);
  });

  test('说明文字不混进选项文本，且 context 带上问题与 ☐ 表头', () => {
    const sel = detectSelection(ASK_MENU_CURSOR_FIRST)!;
    expect(sel.options.some((o) => o.includes('盒子在初始化后朝向保持不变'))).toBe(false);
    expect(sel.context).toContain('盒子朝向');
    expect(sel.context).toContain('是基本保持固定状态');
  });

  test('details 与 options 同序等长：说明按项归位、折行拼回一段', () => {
    const sel = detectSelection(ASK_MENU_CURSOR_FIRST)!;
    expect(sel.details).toHaveLength(sel.options.length);
    expect(sel.details[0]).toBe(
      '盒子在初始化后朝向保持不变，用户看到的视角始终相同。这种情况下可以用静态配置来定义每个盒子的初始朝向，不需要实现动态旋转或翻转的逻辑。适合展示用途或信息板场景。',
    );
    expect(sel.details[1]).toContain('这需要实现完整的状态管理');
    expect(sel.details[2]).toContain('相对低风险的渐进式方案');
    // CC 自带的两项没有说明；分隔线不能被当成说明
    expect(sel.details[3]).toBe('');
    expect(sel.details[4]).toBe('');
  });

  test('details 不随光标移动而错位（末项态归属不变）', () => {
    const sel = detectSelection(ASK_MENU_CURSOR_LAST)!;
    expect(sel.details[0]).toContain('盒子在初始化后朝向保持不变');
    expect(sel.details[2]).toContain('先实现一个基础版本');
    expect(sel.details[4]).toBe('');
  });

  test('说明不进签名：签名口径仍只有 options + cursorIndex', () => {
    expect(selectionSig(detectSelection(ASK_MENU_CURSOR_FIRST)!)).toBe(`${ASK_OPTIONS.join('|')}@0`);
    expect(selectionSig(detectSelection(ASK_MENU_CURSOR_LAST)!)).toBe(`${ASK_OPTIONS.join('|')}@4`);
  });

  test('编号不连续即停：菜单下方正文里的编号列表不被吞进选项', () => {
    const pane = `Do you want to proceed?\n❯ 1. Yes\n  2. No\n\n我接下来会做：\n1. 先读代码\n2. 再改\n`;
    const sel = detectSelection(pane)!;
    expect(sel.options).toEqual(['Yes', 'No']);
  });

  test('间隔超预算即停：远处的续号行不被跨屏粘连', () => {
    const far = `问题\n❯ 1. Yes\n${'无关正文\n'.repeat(30)}  2. 其实是别处的列表\n`;
    const sel = detectSelection(far)!;
    expect(sel.options).toEqual(['Yes']);
  });
});

/**
 * issue #95 真实抓屏语料：AskUserQuestion 的 **多选** 形态（multiSelect:true，tmux 114×38 实抓）。
 * 与单选的差别：每项前面带 `[ ]`/`[✔]` 复选框、表头是 `←  ☒ 要装的模块  ✔ Submit  →`。
 * 实测按键语义：空格/Enter 都只是勾选或取消（菜单不关），要按 → 进复核页选 Submit answers 才提交。
 */
const ASK_MENU_MULTI = `──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☒ 要装的模块  ✔ Submit  →

请选择要安装的模块

❯ 1. [✔] 视觉模块
  采用高精度摄像头和AI视觉识别技术，实时捕捉和分析生产现场的图像数据，支持缺陷检测、质量评估和环境监控，提高产品质
  量控制能力。
  2. [ ] 抓取模块
  集成精密机械臂和智能抓取器，支持多种物体形状和材质的自动抓取操作，具备力度反馈和自适应调节功能，广泛应用于物料搬
  运和装配作业。
  3. [ ] 传送带模块
  提供高效的物料输送解决方案，支持可调速运行和自动排队功能，集成传感器实时监控运行状态，能够与其他模块无缝协作完成
  自动化生产流程。
  4. [ ] Type something
     Submit
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

describe('detectSelection · 多选表单（issue #95）', () => {
  test('multiSelect=true；选项保留复选框状态（与终端所见一致）', () => {
    const sel = detectSelection(ASK_MENU_MULTI)!;
    expect(sel.multiSelect).toBe(true);
    expect(sel.options).toEqual([
      '[✔] 视觉模块',
      '[ ] 抓取模块',
      '[ ] 传送带模块',
      '[ ] Type something',
      'Chat about this',
    ]);
    expect(sel.cursorIndex).toBe(0);
    expect(sel.details[1]).toContain('集成精密机械臂和智能抓取器');
  });

  test('单选 AskUserQuestion 不被误标多选（表头的 ☐ 不作数）', () => {
    // 单选表头也是 `☐ 盒子朝向`——只认选项本体上的复选框，否则普通菜单全被误标
    expect(detectSelection(ASK_MENU_CURSOR_FIRST)!.multiSelect).toBe(false);
    expect(detectSelection(MENU)!.multiSelect).toBe(false);
  });

  test('isMultiSelectOptions：认 [ ] / [✔] / ☐ 前缀，不认普通文本', () => {
    expect(isMultiSelectOptions(['[ ] a', 'b'])).toBe(true);
    expect(isMultiSelectOptions(['[✔] a'])).toBe(true);
    expect(isMultiSelectOptions(['☐ a'])).toBe(true);
    expect(isMultiSelectOptions(['Yes', 'No'])).toBe(false);
    expect(isMultiSelectOptions(['朝向基本固定', 'Chat about this'])).toBe(false);
  });
});

describe('isCodexUpdatePrompt', () => {
  test('识别 codex「有可用更新」交互弹窗', () => {
    const upd = `Update available! 0.144.6 -> 0.145.0\n› 1. Update now\n  2. Skip\nPress enter to continue\n`;
    expect(isCodexUpdatePrompt(upd)).toBe(true);
    expect(isCodexUpdatePrompt('❯ 1. Yes\n  2. No')).toBe(false);
    expect(isCodexUpdatePrompt('')).toBe(false);
  });
});

describe('codexExitedToShell', () => {
  test('自更新退出：出现「Please restart Codex」→ true', () => {
    const pane = `==> Updating Codex CLI from 0.144.6 to 0.145.0\n🎉 Update ran successfully! Please restart Codex.\n[root@VM yuhang_project]#\n`;
    expect(codexExitedToShell(pane)).toBe(true);
  });

  test('末行是 shell 提示符（# / $ 收尾，含用户误发命令报错）→ true', () => {
    expect(codexExitedToShell('[root@VM yuhang_project]# ')).toBe(true);
    expect(codexExitedToShell('-bash: 阿萨德: command not found\n[root@VM yuhang_project]#')).toBe(true);
    expect(codexExitedToShell('user@host:~/p$')).toBe(true);
    // 末尾有空白行也要回溯到末条非空行判定
    expect(codexExitedToShell('[root@VM p]#\n\n  \n')).toBe(true);
  });

  test('codex TUI 在跑（状态栏/输入行不以 $ 或 # 收尾）→ false', () => {
    const tui = `╭─ OpenAI Codex (v0.145.0) ─╮\n› \n  gpt-5.6-sol medium · ~/user_space/users/u12/yuhang_project\n`;
    expect(codexExitedToShell(tui)).toBe(false);
    expect(codexExitedToShell('› 连通性自测：请只回复 pong')).toBe(false);
    expect(codexExitedToShell('')).toBe(false); // 全空白 → 不误判为退回 shell
  });
});
