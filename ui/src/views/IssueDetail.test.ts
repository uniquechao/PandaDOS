import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { CompletionReport, IssueEvent, IssueWorkflowRuntime } from '../lib/types';
import { CLARIFY_ANALYZING_MAX_AGE_MS, clarifyPanelState } from '../lib/issueStatus';
import { completionReportState, workflowConflictFiles, workflowParallelProgress } from './IssueDetail';

const source = readFileSync(new URL('./IssueDetail.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('「已完成但未推送」警示条（#272 / B-02）', () => {
  test('与澄清条同层常驻，红 tint 区分「已出事」与「等你处理」，git 原话限高滚动', () => {
    expect(source).toContain('function PushFailedBar');
    // 挂在澄清条同一层（tab 栏之上，任何 tab 都看得到）
    expect(source).toContain('{pushFailure && <PushFailedBar');
    expect(source).toContain('pushFailureState(events)');
    for (const key of ['issue.pushFailedTitle', 'issue.pushFailedHint', 'issue.pushFailedBranch']) {
      expect(source).toContain(`tr('${key}'`);
    }
    // 不做成按钮：这里没有一键能替用户解决的动作
    expect(source).not.toContain('class="push-failed-bar" onClick');
    expect(source).toContain('role="alert"');

    // 琥珀是「等你处理」，这条必须是红档，且与澄清条同一套度量
    const bar = styles.match(/\.push-failed-bar \{[^}]*\}/)![0];
    expect(bar).toContain('rgba(220, 38, 38');
    expect(bar).toContain('margin: 0 12px 9px');
    expect(bar).toContain('border-radius: var(--r-md)');
    // 长报错不许把 tab 内容顶飞
    const detail = styles.match(/\.push-failed-d \{[^}]*\}/)![0];
    expect(detail).toContain('max-height');
    expect(detail).toContain('overflow: auto');
  });
});

describe('Issue 工作台信息架构', () => {
  test('完成报告按结构分区，未达目标与历史总结提供继续处理入口', () => {
    expect(source).toContain('function CompletionReportCard');
    for (const key of [
      'issue.reportObjective', 'issue.reportImplementation', 'issue.reportAdvantages',
      'issue.reportDisadvantages', 'issue.reportVerification', 'issue.reportCompletion',
      'issue.reportUnmetGoals', 'issue.reportRemainingWork',
    ]) expect(source).toContain(`tr('${key}')`);
    expect(source).toContain("tr('issue.continueProcessing')");
    expect(source).toContain("guidance: doneReopenGuidance.trim()");

    const complete: CompletionReport = {
      version: 1, outcome: 'complete', objective: '目标', implementation: ['方案'],
      advantages: ['优点'], disadvantages: [], verification: ['测试'], completion: '已完成',
      unmetGoals: [], remainingWork: [],
    };
    expect(completionReportState(complete, true, 'done')).toEqual({ tone: 'success', canContinue: false });
    expect(completionReportState({ ...complete, outcome: 'partial', remainingWork: ['部署'] }, true, 'blocked'))
      .toEqual({ tone: 'warning', canContinue: true });
    expect(completionReportState(null, true, 'done')).toEqual({ tone: 'legacy', canContinue: true });
  });
  // #301：这块红底「此 issue 尚未全部完成」被用户当成受阻，实际只是告知
  test('未达目标/后续动作是告知块，不是 alert，也不用受阻的红档', () => {
    expect(source).toContain('class="completion-report-note wide"');
    expect(source).toContain("tr('issue.reportAttentionFyi')");
    expect(source).toContain("tr('issue.reportAttentionNote')");
    // 只是告知就别打断读屏，也别复用红档告警块
    expect(source).not.toContain('class="completion-report-alert wide" role="alert"');
    // 红档留给真出事的：历史记录未经验证、重开 issue 的警告
    expect(source).toContain("tr('issue.reportLegacyWarningTitle')");

    const note = styles.match(/\.completion-report-note \{[^}]*\}/)![0];
    expect(note).toContain('background: var(--fill)');       // 中性 tint，不用 rgba(220, 38, 38…)
    expect(note).not.toContain('220, 38, 38');
    expect(note).toContain('border-left: 3px solid var(--line-2)');
    expect(styles).toContain('.crn-fyi {');                  // 「告知」胶囊：不靠颜色单独表意
    expect(styles).toContain('.completion-report-alert, .completion-report-note { margin: 12px 14px; }');
  });

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

  test('改动 tab 统一展示本 issue 的改动文件，不再呈现 commit 视图', () => {
    expect(source).toContain("type WbTab = 'detail' | 'workflow' | 'exec' | 'changes'");
    expect(source).not.toContain('IssueCommitsTab');
    expect(source).toContain('const byPath = new Map<string, IssueChangeLeaf>()');
    expect(source).toContain('dedupWorktree');
    expect(source).toContain('leaves={leaves}');
    expect(source).toContain('key: `issue:${f.path}`');
    expect(source).toContain("source: 'range'");
    expect(source).toContain("source: 'wt'");
    expect(source).not.toContain('<CommitPanel');
    expect(source).not.toContain("tr('issue.commitHistory'");
  });

  test('宽屏左树右 diff，窄屏维持文件 diff 全屏钻入', () => {
    expect(source).toContain('useWide()');
    expect(source).toContain('useTreeWidth()');
    expect(source).toContain('<ListSplitter containerRef={splitRef} list={treeW}');
    expect(source).toContain('wb-split');
    expect(source).toContain('wb-list-col');
    expect(source).toContain('wb-main');
    expect(source).toContain("tr('issue.chooseChange')");
    expect(source).toContain("tr('issue.collapseDiff')");
    expect(source).toContain('selKey={fd.file?.key}');
    expect(source).toContain('!wide && fd.file');
  });

  test('合并后仍按文件来源选择工作区或本 issue 范围 diff', () => {
    expect(source).toContain("type IssueChangeLeaf = ChangeLeaf & { source: 'range' | 'wt' }");
    expect(source).toContain("leaf.source === 'wt'");
    expect(source).toContain("leaf.code === '?'");
    expect(source).toContain('/git/worktree/diff?${q}');
    expect(source).toContain('/git/diff?${q}');
    expect(source).toContain("tr('issue.noChangesRunning')");
    expect(source).toContain("tr('issue.noChanges')");
    expect(source).toContain("tr('issue.mergedNoChanges', { base: info.base })");
    expect(source).toContain('info.worktree !== undefined');
  });

  test('状态头只显示本 issue 文件数，不显示提交、推送或分支元数据', () => {
    expect(source).toContain('function IssueGitHead({ count, onRefresh }');
    expect(source).toContain("tr('issue.fileCount', { count })");
    expect(source).not.toContain('function IssueGitStatus');
    expect(source).not.toContain("tr('issue.commitCount'");
    expect(source).not.toContain("tr('issue.aheadOrigin'");
    expect(source).not.toContain('⎇ {info.branch}');
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
    expect(source).toContain('class="btn sm plan-edit"');
    expect(source).toContain('class="plan-edit-icon"');
    expect(source).not.toContain('class="btn sm ghost plan-edit"');
    expect(styles).toMatch(/\.plan-edit\s*\{[^}]*border-color:\s*var\(--line-2\)[^}]*background:\s*var\(--card\)[^}]*box-shadow:\s*var\(--sh-1\)/s);
    expect(styles).toContain('.plan-edit:hover:not(:disabled)');
    expect(styles).toContain('.plan-edit:active:not(:disabled)');
    expect(styles).toContain('.plan-edit:focus-visible');
    expect(styles).toMatch(/@media \(max-width: 719px\)\s*\{[^}]*\.plan-edit\s*\{[^}]*min-height:\s*44px/s);
  });

  test('受阻恢复必须经弹窗提交解除方法，并提供编辑 issue 与受阻子任务入口', () => {
    expect(source).toContain('function BlockedRecoveryModal');
    expect(source).toContain('setRecoveryOpen(true)');
    expect(source).toContain("{ guidance: recoveryGuidance.trim() }");
    expect(source).toContain("tr('issue.recoveryGuidanceRequired')");
    expect(source).toContain("tr('issue.editBlockedIssue')");
    expect(source).toContain("tr('issue.editBlockedSubtask')");
    expect(source).toContain("issue.status === 'pending' || ['blocked', 'paused'].includes(issue.status)");
    expect(source).not.toContain('onUnblock={() => void post(`/api/projects/${pid}/issues/${iid}/unblock`)}');
    expect(styles).toContain('.blocked-recovery');
    expect(styles).toContain('.recovery-tools');
  });

  // #301：受阻只显示一句原因时，用户看不出「这是告知还是要我动手」
  test('受阻原因按三段拆成三行，行动指引单独强调，解析不出来退回原句', () => {
    expect(source).toContain('function BlockedReason');
    expect(source).toContain("parseBlockedNote(reason)");
    // 解析失败（老 issue、引擎自判的受阻）原样显示那句话
    expect(source).toContain("if (!parts) return <div class=\"block-box\">{reason}</div>;");
    for (const key of ['issue.blockedDoing', 'issue.blockedStuck', 'issue.blockedAction']) {
      expect(source).toContain(`tr('${key}')`);
    }
    // 卡点条与恢复弹窗共用同一个渲染，别再各写各的
    expect(source.match(/<BlockedReason reason=\{props\.blockedReason\} \/>/g)!.length).toBe(2);
    expect(source).not.toContain('<div class="block-box">{props.blockedReason}</div>');
    // 标题明说「需要你处理」+ 一句说明：受阻不是告知，系统不会自己继续
    expect(source).toContain("tr('issue.blockedNeedsYou')");
    expect(source).toContain("tr('issue.blockedNeedsYouHint')");

    // 三行结构：标签列定宽对齐，行动行加重且窄屏退成上下两行
    expect(styles).toContain('.block-lines {');
    expect(styles).toContain('.block-line.act .block-line-v { font-weight: 650; }');
    expect(styles).toMatch(/@media \(max-width: 380px\) \{ \.block-line \{ flex-direction: column;/);
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

describe('Issue 工作流实时视图（Issue #33）', () => {
  test('工作流 tab 展示轮询运行态、节点图、路由原因、冲突和恢复提示', () => {
    expect(source).toContain("tab === 'workflow' && detail?.workflowRuntime");
    expect(source).toContain('<WorkflowGraph graph={runtime.workflow.graph} runs={runtime.runs} />');
    expect(source).toContain('runtime.transitions.find((transition) => transition.fromRunId === run.id)?.decisionText');
    expect(source).toContain("runtime.workflow.status === 'paused'");
    expect(source).toContain('workflowConflictFiles(worktree.conflictDetails)');
    expect(source).toContain("tab !== 'exec' && gateBar");
    expect(styles).toContain('.wfr-progress-grid {');
    expect(styles).toContain('.wfr-conflict {');
  });

  test('运行状态、分支原因和 worktree 合并诊断使用类型映射及无障碍名称', () => {
    expect(source).toContain('issueWorkflowStatusKey(runtime.workflow.status)');
    expect(source).toContain('workflowNodeStatusKey(run.status)');
    expect(source).toContain('workflowWorktreeStatusKey(worktree.status)');
    expect(source).toContain("tr('workflow.parallelProgressAria'");
    expect(source).toContain("tr('workflow.worktreeAria'");
    expect(source).toContain("tr('workflow.conflictAria'");
    expect(source).toContain("tr('workflow.runAria'");
    expect(source).toContain("tr('workflow.routeReasonAria'");
  });

  test('并行进度按组和节点去重，重试成功会覆盖失败态', () => {
    const runtime = {
      runs: [
        { id: 1, nodeKey: 'a', parallelGroupKey: 'g', status: 'failed' },
        { id: 2, nodeKey: 'a', parallelGroupKey: 'g', status: 'succeeded' },
        { id: 3, nodeKey: 'b', parallelGroupKey: 'g', status: 'running' },
      ],
    } as IssueWorkflowRuntime;
    expect(workflowParallelProgress(runtime)).toEqual([{ key: 'g', done: 1, total: 2 }]);
  });

  test('冲突诊断兼容 files 和 conflictedFiles 契约及非 JSON 文本', () => {
    expect(workflowConflictFiles('{"files":["a.ts","b.ts"]}')).toEqual(['a.ts', 'b.ts']);
    expect(workflowConflictFiles('{"conflictedFiles":["c.ts"]}')).toEqual(['c.ts']);
    expect(workflowConflictFiles('git conflict')).toEqual([]);
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

describe('执行页门禁一行（#279 / I-03）', () => {
  test('只读展示：接详情接口的 validation，不给「重跑」按钮', () => {
    expect(source).toContain('validation={detail?.validation ?? null}');
    expect(source).toContain('<ValidationLine validation={validation} />');
    // 范围 / 结果 / 耗时三段都在
    expect(source).toContain("tr('issue.validationTargeted'");
    expect(source).toContain("tr('issue.validationFull')");
    expect(source).toContain("tr('issue.validationPassed')");
    expect(source).toContain("tr('issue.validationFailed'");
    expect(source).toContain('fmtDuration(last.durationMs)');
    // 门禁由引擎自己跑，界面上不该出现任何触发按钮——手动重跑正是本条要消灭的开销
    const line = source.slice(source.indexOf('function ValidationLine'), source.indexOf('function PushFailedBar'));
    expect(line).not.toContain('<button');
    expect(line).not.toContain('onClick');
  });

  test('没有门禁信息时整行不渲染，不占位', () => {
    const line = source.slice(source.indexOf('function ValidationLine'), source.indexOf('function PushFailedBar'));
    expect(line).toContain('return null');
  });
});

describe('执行页推理档一行（#281 / I-04）', () => {
  test('可选覆盖档 + 显示生效档与来源，并说明「下次启动才生效」', () => {
    expect(source).toContain('reasoning={detail?.reasoning ?? null}');
    expect(source).toContain('<ReasoningLine reasoning={reasoning} onChange={onReasoning} />');
    expect(source).toContain("tr('ui.reasoningInherit')"); // 继承模块 = 清空覆盖
    expect(source).toContain("tr('issue.reasoningEffective'");
    expect(source).toContain("tr('ui.reasoningCodexOnly')");
    // 改档走 PATCH reasoningEffort，且改完只刷新详情——不重启会话（effort 是启动参数）
    expect(source).toContain("'PATCH', { reasoningEffort: next }");
    const line = source.slice(source.indexOf('function ReasoningLine'), source.indexOf('function ValidationLine'));
    expect(line).not.toContain('relaunch');
  });
});

describe('执行页工具条合成一行（#300）', () => {
  test('门禁 / 推理档内联进 .runctl 的 seg 插槽，不再各占一整行', () => {
    const seg = source.slice(source.indexOf('const seg = ('), source.indexOf('<div class="wb-exec-body">'));
    // 顺序：对话/原生 → 审批 → 门禁 → 推理档 → 子任务进度
    expect(seg.indexOf('<NativeModeSwitch')).toBeLessThan(seg.indexOf('<AutoApproveSwitch'));
    expect(seg.indexOf('<AutoApproveSwitch')).toBeLessThan(seg.indexOf('<ValidationLine'));
    expect(seg.indexOf('<ValidationLine')).toBeLessThan(seg.indexOf('<ReasoningLine'));
    expect(seg.indexOf('<ReasoningLine')).toBeLessThan(seg.indexOf('<ExecProgress'));
    // .wb-exec 里不再有独立成行的门禁/推理档（seg 是三条渲染路径共用的唯一出处）
    const exec = source.slice(source.indexOf('<div class="wb-exec">'), source.indexOf('type TermPaneComp'));
    expect(exec).not.toContain('<ValidationLine');
    expect(exec).not.toContain('<ReasoningLine');
  });

  test('内联件是紧凑组：无整行 padding / 下边框，且不被进度链挤扁', () => {
    const line = styles.match(/\.val-line \{[^}]*\}/)![0];
    expect(line).not.toContain('border-bottom');
    expect(line).toContain('flex: 0 0 auto');
    expect(line).toContain('inline-flex');
    // 推理档下拉用工具条尺寸，不借模块面板的宽下拉
    expect(source).toContain('class="rc-sel"');
    expect(styles).toContain('.rc-sel {');
  });

  test('「运行中」只留呼吸绿点，文案进 title / aria-label（项目对话页同一控件条）', () => {
    const runctl = readFileSync(new URL('../components/RunControls.tsx', import.meta.url), 'utf8');
    expect(runctl).not.toContain(">{t('ui.runRunning')}<");
    expect(runctl).toContain("aria-label={t('ui.runRunning')}");
    expect(runctl).toContain('role="status"');
    // 没有文字撑开了，点自身要有确定尺寸
    const label = styles.match(/\.rc-label \{[^}]*\}/)![0];
    expect(label).toContain('width: 7px');
    expect(label).toContain('height: 7px');
  });

  test('文案只留必要的：生效档只显示档位值，整句与「仅 codex 生效」进 title', () => {
    const line = source.slice(source.indexOf('function ReasoningLine'), source.indexOf('function ValidationLine'));
    expect(line).toContain("tr('issue.reasoningEffective'");
    expect(line).toContain("tr('ui.reasoningCodexOnly')");
    expect(line).toContain('title={hint}');
    expect(line).toContain('>{reasoning.effort}</span>');
  });
});

describe('已排队等待恢复（#283 / B-10）', () => {
  test('详情页常驻提示条：说清不用再点第二次，并给撤销入口', () => {
    expect(source).toContain('detail?.unblockRequest && (');
    expect(source).toContain('<UnblockQueuedBar request={detail.unblockRequest} onCancel={cancelUnblockQueue} />');
    expect(source).toContain("tr('issue.unblockQueued')");
    expect(source).toContain("tr('issue.unblockQueuedCancel')");
    expect(source).toContain("/unblock/cancel`, 'POST'");
  });

  test('提示条是 status 角色而不是 alert：这不是故障，只是在排队', () => {
    const bar = source.slice(source.indexOf('function UnblockQueuedBar'), source.indexOf('function ReasoningLine'));
    expect(bar).toContain('role="status"');
    expect(bar).not.toContain('role="alert"');
  });
});

describe('一键拆回智能合并（#289 / B-14）', () => {
  test('详情页给出拆回入口，并在宿主已开跑时置灰说明原因', () => {
    expect(source).toContain('detail?.mergedFrom && <MergedFromBar');
    expect(source).toContain("tr('issue.mergedFrom')");
    expect(source).toContain("tr('issue.unmerge')");
    expect(source).toContain("tr('issue.unmergeLocked')");
    expect(source).toContain("/unmerge`, 'POST'");
    const bar = source.slice(source.indexOf('function MergedFromBar'), source.indexOf('function UnblockQueuedBar'));
    expect(bar).toContain('disabled={!info.canUnmerge}'); // 开跑后不给点，比点了报错强
  });
});
