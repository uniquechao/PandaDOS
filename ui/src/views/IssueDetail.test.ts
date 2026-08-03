import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { IssueEvent } from '../lib/types';
import { CLARIFY_ANALYZING_MAX_AGE_MS, clarifyPanelState } from '../lib/issueStatus';

const source = readFileSync(new URL('./IssueDetail.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('Issue 工作台信息架构', () => {
  test('执行页复用“对话/原生”切换，原生严格钉住当前 issue 且移除暂停/接管重复动作', () => {
    expect(source).toContain('<NativeModeSwitch mode={mode} onChange={setMode} />');
    expect(source).toContain('target={{ kind: \'issue\', issueId: issue.id }}');
    expect(source).toContain('nativeUnavailableReason(issue)');
    expect(source).toContain("tr('issue.nativeSessionUnavailable')");
    expect(source).toContain("unavailable ? tr('issue.nativeUnavailable')");
    expect(source).not.toContain("useState<'chat' | 'term'>");
    expect(source).not.toContain('onTakeover');
    expect(source).not.toContain('onPause');
    expect(source).not.toContain('⌨ 接管');
    expect(source).not.toContain('⏸ 暂停');
  });

  test('详情页不再展示审计时间线，但保留事件业务数据和执行过程入口', () => {
    expect(source).not.toContain('时间线（');
    expect(source).not.toContain('function EventRow');
    expect(source).not.toContain('class="tl"');

    expect(source).toContain('/events`');
    expect(source).toContain('const blockedReason = useMemo');
    expect(source).toContain('<ChatPane');
  });

  test('模块共享会话把分段和当前 issue 交给 ChatPane，用于严格过滤当前 issue 区间', () => {
    expect(source).toContain('conversationSegments={detail?.conversationSegments ?? []}');
    expect(source).toContain('currentIssueId={issue.id}');
  });

  test('澄清改提示条+弹窗（#103）+ 状态覆盖「等待用户澄清」+ GateBar 不再重复渲染问题', () => {
    // 紧凑提示条常驻 tab 栏之上（任何 tab 都看得到），点击才弹窗回答——不再整面板挤占 tab 内容
    expect(source).toContain('function ClarifyBar');
    expect(source).toContain('setClarifyOpen(true)');
    expect(source).toContain('const clarifyPanel');
    expect(source).toContain('{clarifyPanel}');
    // 弹窗承接原面板全部内容（问题清单完整展示随弹窗滚动），提交即关窗
    expect(source).toContain('function ClarifyPanel');
    expect(source).toContain("<Modal title={tr('issue.clarification')}");
    expect(source).toContain("tr('issue.submitClarification')");
    // 状态徽标覆盖：awaitingClarify 透传给 StatusBadge（仅 issue 详情页）
    expect(source).toContain('awaitingClarify={issue.awaitingClarify}');
    // 澄清面板派生统一走纯函数 clarifyPanelState（lib/issueStatus，事件溯源，含 clarify_timeout 终止）
    expect(source).toContain('clarifyPanelState(');
    // GateBar 去掉与顶部面板重复的问题渲染/属性
    expect(source).not.toContain('clarifyQuestions={clarifyQuestions}');
    expect(source).not.toContain('onClarify={');
  });

  test('澄清面板附原始需求：标题常显 + 正文可折叠（答问题时看得到在答什么）', () => {
    expect(source).toContain('clarify-ctx');
    expect(source).toContain("tr('issue.originalRequest')");
    expect(source).toContain('title={issue.title}');
    expect(source).toContain('body={issue.body}');
  });

  test('review 状态缺 gate 时提供重试与取消，不把按钮永久禁用在“加载中”', () => {
    expect(source).toContain('/issues/${iid}/retry-gate');
    expect(source).toContain("tr('issue.gateFailed')");
    expect(source).toContain("tr('issue.regenerateReview')");
    expect(source).toContain("tr('issue.cancelTask')");
    expect(source).not.toContain('（卡点数据加载中…）');
  });

  test('提交併入改动（#80）：四 tab→三 tab，改动 tab = 未提交树 + 已提交树 + 提交记录区', () => {
    // tab 收敛：不再有独立提交 tab / IssueCommitsTab
    expect(source).toContain("type WbTab = 'detail' | 'exec' | 'changes'");
    expect(source).not.toContain('IssueCommitsTab');
    // 双树都走 ChangeTree（构树/折叠在组件与 lib/changetree），worktree 两列码先归一
    expect(source).toContain('<ChangeTree leaves={wtLeaves}');
    expect(source).toContain('<ChangeTree leaves={rangeLeaves}');
    expect(source).toContain('dedupWorktree');
    // 分区标题：未提交 / 已提交 / 提交记录
    expect(source).toContain("tr('issue.runningUncommitted')");
    expect(source).toContain("tr('issue.committed')");
    expect(source).toContain("tr('issue.commitHistory', { count: info.commits.length })");
    // 提交钻入保留（全屏 CommitPanel + 返回）
    expect(source).toContain('<CommitPanel key={sha}');
  });

  test('宽屏分栏：左列树+提交记录可拖宽，右栏 diff/CommitPanel/占位；窄屏维持全屏钻入', () => {
    // 宽窄两态：useWide 判宽，左列宽度复用文件页文件树偏好（lib/treewidth）+ ListSplitter 拖拽
    expect(source).toContain('useWide()');
    expect(source).toContain('useTreeWidth()');
    expect(source).toContain('<ListSplitter containerRef={splitRef} list={treeW}');
    expect(source).toContain('wb-split');
    expect(source).toContain('wb-list-col');
    expect(source).toContain('wb-main');
    // 右栏三态：提交详情 / 文件 diff（可收起）/ 未选占位
    expect(source).toContain("tr('issue.chooseChange')");
    expect(source).toContain("tr('issue.collapseDiff')");
    // 文件与提交互斥选中；选中项在左列高亮（树 selKey / 提交行 .on）
    expect(source).toContain('setSha(null); // 文件与提交互斥选中');
    expect(source).toContain('selKey={fd.file?.leaf.key}');
    expect(source).toContain("wide && sha === c.sha ? ' on'");
    // 窄屏才走全屏钻入分支
    expect(source).toContain('!wide && sha');
    expect(source).toContain('!wide && fd.file');
  });

  test('改动 tab 选中路由：wt 走项目级 worktree diff（untracked 由码 ? 判定），range 走本 issue 范围端点', () => {
    expect(source).toContain("{ kind: 'range' | 'wt'; leaf: ChangeLeaf }");
    expect(source).toContain("s.leaf.code === '?'");
    expect(source).toContain('/git/worktree/diff?${q}');
    expect(source).toContain('/git/diff?${q}');
    expect(source).toContain("openLeaf('wt', l)");
    expect(source).toContain("openLeaf('range', l)");
    // 空态按状态区分：未启动 / 执行中尚未提交 / 已并入
    expect(source).toContain("tr('issue.noChangesRunning')");
    expect(source).toContain("tr('issue.noChanges')");
    expect(source).toContain("tr('issue.mergedNoChanges', { base: info.base })");
    // 「正在进行」视角以后端 worktree 字段有无为准（仅活跃 issue 附带）
    expect(source).toContain('info.worktree !== undefined');
  });

  test('状态头单行（#101）：提交数 · 推送状态 · 已提交文件数 · 工作区未提交数 + 快照来源标注', () => {
    expect(source).toContain('function IssueGitStatus');
    // 状态段只在 IssueGitHead 内行内渲染一次（并成单行），不再独立成行；↑N 徽标与「N 条提交」重复已删
    expect(source.split('<IssueGitStatus info={info} />').length - 1).toBe(1);
    expect(source).not.toContain('↑{info.ahead}');
    expect(source).toContain("tr('issue.commitCount', { count: info.ahead })");
    // 推送状态全谱文案（badge 配色按语义：绿=已推送，琥珀=有未推送，灰=无远程）
    expect(source).toContain("{ text: tr('issue.pushed'), cls: 'b-green' }");
    expect(source).toContain("tr('issue.aheadOrigin', { count: p.n })");
    expect(source).toContain("tr('issue.notPushed')");
    expect(source).toContain("tr('issue.noRemote')");
    expect(source).toContain("tr('issue.fileCount', { count: info.files.length })");
    expect(source).toContain("tr('issue.uncommittedFiles', { count: wtN })");
    // 快照兜底提示
    expect(source).toContain("tr('issue.snapshot')");
  });

  test('角标常显：进详情即预取 git info；改动角标 = 已提交∪未提交去重文件数', () => {
    // 预取不再等点开 tab：enabled=详情已加载；刷新键复合 状态+是否在改动 tab
    expect(source).toContain("useIssueGit(pid, iid, issue !== null, `${issue?.status ?? ''}|${needGit ? 1 : 0}`)");
    expect(source).toContain("const needGit = tab === 'changes'");
    // 改动角标去重合并未提交（执行中也能看到规模）；独立提交角标随 tab 合并移除
    expect(source).toContain('const changesN = useMemo');
    expect(source).toContain("{tr('issue.changesTab')}{changesN > 0 ?");
    expect(source).not.toContain('提交{git.info');
  });

  test('详情头部并成一条折行（#105）：#id+标题+徽标+动作同一行，动作靠右成组', () => {
    expect(source).toContain('id-head-line');
    expect(source).toContain('class="id-acts"');
    expect(source).toContain('btitle id-title');
    // 旧的两行结构（标题行 bhead-row + 徽标行 id-badges）不再出现
    expect(source).not.toContain('bhead-row');
    expect(source).not.toContain('id-badges');
  });

  test('详情「计划」清单与执行顶栏进度链同一状态源/配色（#104）：ep-n 圆点替换 emoji', () => {
    // 状态判定收口到 execProgressState（含 blocked/cancelled），圆点字形共用 stepGlyph
    expect(source).toContain('execProgressState(subs, issue.subIndex, issue.status)');
    expect(source).toContain('ck ep-n ${step.state}');
    expect(source).toContain('{stepGlyph(step)}');
    expect(source).not.toContain('▶️');
    expect(source).not.toContain('⬜');
  });

  test('详情计划只为未派发子任务提供内联编辑，并支持保存、取消与键盘操作', () => {
    expect(source).toContain('canEditSubtask(');
    expect(source).toContain('/subtasks/${index}`');
    expect(source).toContain("api<{ ok: true; index: number; subtask: Subtask }>");
    expect(source).toContain('class="plan-editor"');
    expect(source).toContain('onSubmit={(event) =>');
    expect(source).toContain("event.key === 'Enter'");
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("tr('issue.editSubtask', { number: step.n })");
    expect(source).toContain("tr('issue.subtaskText')");
    expect(source).toContain("tr('ui.saving')");
    expect(source).toContain("tr('ui.cancel')");
  });

  test('当前子任务旋转环使用带居中位移的旋转关键帧，不再依赖负 margin 猜测中心', () => {
    expect(styles).toContain('transform: translate(-50%, -50%) rotate(360deg)');
    expect(styles).toContain('.plan-i .ck.ep-n {');
    expect(styles).toContain('width: 23px');
    expect(styles).not.toContain('margin: -14.5px 0 0 -14.5px');
  });

  test('「分析中」占位与「最新分析」反馈标题已接入渲染', () => {
    // 澄清面板与「代理反馈」区的重新分析占位
    expect(source).toContain("tr('issue.agentReanalyzingInline')");
    expect(source).toContain('analyzingOnly');
    // 反馈标题不再叫「创建时分析」——每轮答复/改正文都会重析
    expect(source).toContain("tr('issue.agentFeedback')");
    // 分析中也展示反馈区块（无旧反馈时只有占位）
    expect(source).toContain('(issue.clarifyFeedback || analyzing)');
  });
});

// ---------- 澄清面板派生（clarifyPanelState）：多轮问答闭环 ----------

/** 事件流工厂：id/ts 递增（id 步长 1、ts 步长 1s），data 省略 → dataJson null */
function mkEvents() {
  let id = 0;
  const list: IssueEvent[] = [];
  const push = (kind: string, data?: Record<string, unknown>): IssueEvent => {
    id += 1;
    const e: IssueEvent = {
      id,
      issueId: 1,
      kind,
      dataJson: data ? JSON.stringify(data) : null,
      ts: 1_000_000 + id * 1000,
    };
    list.push(e);
    return e;
  };
  return { list, push, now: () => 1_000_000 + (id + 1) * 1000 };
}

describe('clarifyPanelState：「分析中」占位随派生标记显示/隐藏', () => {
  test('clarify_started 无终结 → analyzing=true 且面板展开（无问题也展开）', () => {
    const ev = mkEvents();
    ev.push('clarify_started');
    const st = clarifyPanelState('pending', ev.list, {}, ev.now());
    expect(st.analyzing).toBe(true);
    expect(st.questions).toEqual([]);
    expect(st.visible).toBe(true); // 仅凭分析中即展开（占位）
  });

  test('clarify_done / clarify_discarded / error@where=clarify 任一终结 → 占位隐藏', () => {
    for (const done of [
      { kind: 'clarify_done' },
      { kind: 'clarify_discarded' },
      { kind: 'error', data: { where: 'clarify', reason: 'timeout' } },
    ]) {
      const ev = mkEvents();
      ev.push('clarify_started');
      ev.push(done.kind, done.data);
      const st = clarifyPanelState('pending', ev.list, {}, ev.now());
      expect(st.analyzing).toBe(false);
      expect(st.visible).toBe(false); // 无问题无标记 → 整个面板收起
    }
  });

  test('无关 error（where≠clarify）不终结占位', () => {
    const ev = mkEvents();
    ev.push('clarify_started');
    ev.push('error', { where: 'scheduleNext', error: 'x' });
    expect(clarifyPanelState('pending', ev.list, {}, ev.now()).analyzing).toBe(true);
  });

  test('悬空 started 超过兜底时限（服务重启丢链）→ 自愈不再显示分析中', () => {
    const ev = mkEvents();
    const started = ev.push('clarify_started');
    const late = started.ts + CLARIFY_ANALYZING_MAX_AGE_MS + 1;
    expect(clarifyPanelState('pending', ev.list, {}, late).analyzing).toBe(false);
  });

  test('终态（done/cancelled）一律收起：即便事件上还挂着未终结的分析/未答问题', () => {
    const ev = mkEvents();
    ev.push('clarify_questions', { questions: ['问 1？'] });
    ev.push('clarify_started');
    for (const s of ['done', 'cancelled'] as const) {
      expect(clarifyPanelState(s, ev.list, { clarifyPending: true }, ev.now())).toEqual({
        visible: false,
        questions: [],
        text: '',
        analyzing: false,
      });
    }
  });
});

describe('clarifyPanelState：多轮问答闭环（新一轮覆盖旧问题、答完收起）', () => {
  test('答复后重析 → 新一轮 clarify_questions 到达：面板重新展开、旧问题被覆盖', () => {
    const ev = mkEvents();
    // 首轮分析：反馈 + 问 1
    ev.push('clarify_started');
    ev.push('clarify_done', { questions: 1 });
    ev.push('clarify_questions', { questions: ['问 1？'] });
    let st = clarifyPanelState('pending', ev.list, {}, ev.now());
    expect(st.visible).toBe(true);
    expect(st.questions).toEqual(['问 1？']);
    expect(st.analyzing).toBe(false);

    // 用户回答 → 问题收起；引擎随即重析 → 只剩「分析中」占位
    ev.push('clarified', { answer: 'CSV 就行', source: 'pending' });
    ev.push('clarify_started');
    st = clarifyPanelState('pending', ev.list, {}, ev.now());
    expect(st.questions).toEqual([]); // 已答问题不再显示
    expect(st.analyzing).toBe(true);
    expect(st.visible).toBe(true); // 占位维持展开

    // 第二轮落定：新问题覆盖旧问题、面板重新展开
    ev.push('clarify_done', { questions: 1 });
    ev.push('clarify_questions', { questions: ['问 2？'] });
    st = clarifyPanelState('pending', ev.list, {}, ev.now());
    expect(st.visible).toBe(true);
    expect(st.questions).toEqual(['问 2？']); // 只显示最新一批
    expect(st.analyzing).toBe(false);
  });

  test('答完且重析无新问题：面板与占位全部收起（闭环收敛）', () => {
    const ev = mkEvents();
    ev.push('clarify_started');
    ev.push('clarify_done', { questions: 1 });
    ev.push('clarify_questions', { questions: ['问 1？'] });
    ev.push('clarified', { answer: '按默认', source: 'pending' });
    ev.push('clarify_started');
    ev.push('clarify_done', { questions: 0 }); // 无新问题 = 理解一致
    const st = clarifyPanelState('pending', ev.list, {}, ev.now());
    expect(st).toEqual({ visible: false, questions: [], text: '', analyzing: false });
  });

  test('原文全文（#110）：随最近一批问题带出，答复/超时后一起清空；旧事件无 text → 空串', () => {
    const ev = mkEvents();
    const raw = '现状是这样的：\n1. 档位放哪层？\n   A. 对话上\n   B. issue 一份';
    ev.push('clarify_questions', { questions: ['档位放哪层？'], text: raw, source: 'exec' });
    let st = clarifyPanelState('implementing', ev.list, {}, ev.now());
    expect(st.text).toBe(raw); // 原样（含换行缩进）交给弹窗整段渲染
    expect(st.visible).toBe(true);

    ev.push('clarified', { answer: 'A', source: 'exec' });
    st = clarifyPanelState('implementing', ev.list, {}, ev.now());
    expect(st.text).toBe('');
    expect(st.visible).toBe(false);

    // 旧事件（迁移前）没有 text 字段：questions 照旧、text 空串 → 弹窗回退编号清单
    const old = mkEvents();
    old.push('clarify_questions', { questions: ['问 1？'] });
    const stOld = clarifyPanelState('pending', old.list, {}, old.now());
    expect(stOld.text).toBe('');
    expect(stOld.questions).toEqual(['问 1？']);
    expect(stOld.visible).toBe(true);
  });

  test('只有原文没抽到清单项（代理没规范列编号）也能展开面板', () => {
    const ev = mkEvents();
    ev.push('clarify_questions', { questions: [], text: '这块儿到底按哪个方案做？', source: 'exec' });
    const st = clarifyPanelState('planning', ev.list, {}, ev.now());
    expect(st.visible).toBe(true);
    expect(st.text).toBe('这块儿到底按哪个方案做？');
  });

  test('clarify_timeout（20 分钟自动继续）同样收起问题', () => {
    const ev = mkEvents();
    ev.push('clarify_questions', { questions: ['问 1？'], source: 'exec' });
    ev.push('clarify_timeout');
    const st = clarifyPanelState('implementing', ev.list, {}, ev.now());
    expect(st.questions).toEqual([]);
    expect(st.visible).toBe(false);
  });

  test('服务端标记单独也能展开：awaitingClarify / clarifyPending', () => {
    expect(clarifyPanelState('planning', [], { awaitingClarify: true }).visible).toBe(true);
    expect(clarifyPanelState('pending', [], { clarifyPending: true }).visible).toBe(true);
    expect(clarifyPanelState('pending', [], {}).visible).toBe(false);
  });
});

describe('Issue 详情头部：当前模型徽标（issue #109）', () => {
  test('顶部徽标行显示执行会话的模型；未开跑（无 convId）不请求也不显示', () => {
    expect(source).toContain("from '../lib/useConvModel'");
    expect(source).toContain('useConvModel(pid, issue?.convId ?? null)');
    expect(source).toContain('<ModelBadge model={model} />');
    // 徽标落在 id-head 行内（跟在 codex 徽标之后），不是塞进 tab 内容里
    const idxHead = source.indexOf('class="id-head-line"');
    const idxTabs = source.indexOf('class="id-tabs wb-tabs"');
    const idxBadge = source.indexOf('<ModelBadge model={model} />');
    expect(idxBadge).toBeGreaterThan(idxHead);
    expect(idxBadge).toBeLessThan(idxTabs);
  });
});
