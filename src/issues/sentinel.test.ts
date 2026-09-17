import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from '../core/jsonl';
import {
  countSubtaskDone,
  extractAssistantTexts,
  extractClarifyText,
  findBlocked,
  findNeedClarify,
  findStageDone,
  findTestsFailed,
  looksRateLimited,
  MAX_BLOCKED_NOTE_CHARS,
  MAX_CLARIFY_TEXT_CHARS,
  parseClarifyQuestions,
  parseCompletionReportBlock,
  parseSubtasksBlock,
} from './sentinel';

const ID = 42;

describe('哨兵矩阵：STAGE_DONE 整行匹配 + 核 id + 核 stage', () => {
  test('正例：整行命中（允许首尾空白/宽容分隔空格）', () => {
    expect(findStageDone(`好的\nSTAGE_DONE:42:implementing\n收工`, ID, 'implementing')).toBe(true);
    expect(findStageDone(`  STAGE_DONE: 42 : testing  `, ID, 'testing')).toBe(true);
  });

  test('错 id = 拒', () => {
    expect(findStageDone('STAGE_DONE:43:implementing', ID, 'implementing')).toBe(false);
    expect(findStageDone('STAGE_DONE:420:implementing', ID, 'implementing')).toBe(false);
  });

  test('错 stage = 拒（与当前状态不一致）', () => {
    expect(findStageDone('STAGE_DONE:42:implementing', ID, 'testing')).toBe(false);
    expect(findStageDone('STAGE_DONE:42:testing', ID, 'implementing')).toBe(false);
  });

  test('子串出现（同行还有别的内容）= 拒 —— v1 事故源', () => {
    expect(findStageDone('完成后我会输出 STAGE_DONE:42:implementing 这一行', ID, 'implementing')).toBe(false);
    expect(findStageDone('`STAGE_DONE:42:implementing`', ID, 'implementing')).toBe(false);
    expect(findStageDone('- STAGE_DONE:42:implementing', ID, 'implementing')).toBe(false);
  });

  test('复述格式说明（占位符/非数字 id）= 拒', () => {
    expect(findStageDone('STAGE_DONE:<issueId>:implementing', ID, 'implementing')).toBe(false);
  });
});

describe('哨兵矩阵：SUBTASK_DONE 计数（v1 布尔丢 DONE 修复）', () => {
  test('同一批两个 DONE 计 2', () => {
    expect(countSubtaskDone(`SUBTASK_DONE:42\n中间说了点啥\nSUBTASK_DONE:42`, ID)).toBe(2);
  });
  test('错 id 不计；子串不计', () => {
    expect(countSubtaskDone('SUBTASK_DONE:41', ID)).toBe(0);
    expect(countSubtaskDone('我将输出 SUBTASK_DONE:42 表示完成', ID)).toBe(0);
  });
});

describe('哨兵矩阵：ISSUE_BLOCKED / TESTS_FAILED', () => {
  test('BLOCKED 带原因', () => {
    expect(findBlocked('ISSUE_BLOCKED:42 缺少数据库密码', ID)).toEqual({ note: '缺少数据库密码' });
    expect(findBlocked('ISSUE_BLOCKED:42：中文冒号也行', ID)).toEqual({ note: '中文冒号也行' });
  });
  // #301：原因改成「在做什么｜卡在哪｜要我做什么」三段式，200 字会把最要紧的第三段截掉
  test('BLOCKED 三段式原因留到 400 字，不再 200 字截断', () => {
    const long = `${'甲'.repeat(150)}｜${'乙'.repeat(150)}｜${'丙'.repeat(150)}`;
    const note = findBlocked(`ISSUE_BLOCKED:42 ${long}`, ID)!.note;
    expect(note.length).toBe(MAX_BLOCKED_NOTE_CHARS);
    expect(note).toContain('丙'); // 第三段（要用户做什么）还在
  });
  test('BLOCKED 错 id / 子串 = 拒', () => {
    expect(findBlocked('ISSUE_BLOCKED:41 原因', ID)).toBeNull();
    expect(findBlocked('若卡住会输出 ISSUE_BLOCKED:42 xx', ID)).toBeNull();
  });
  test('TESTS_FAILED 带原因 / 错 id 拒', () => {
    expect(findTestsFailed('TESTS_FAILED:42 3 个用例挂了', ID)).toEqual({ note: '3 个用例挂了' });
    expect(findTestsFailed('TESTS_FAILED:7 x', ID)).toBeNull();
  });
});

describe('哨兵矩阵：只认 assistant 文本', () => {
  test('extractAssistantTexts 排除 tool_result/user/thinking', () => {
    const msgs: ChatMessage[] = [
      { seq: 0, role: 'assistant', text: 'STAGE_DONE:42:testing' },
      { seq: 1, role: 'tool_result', result: 'STAGE_DONE:42:testing' },
      { seq: 2, role: 'user', text: 'STAGE_DONE:42:testing' },
      { seq: 3, role: 'thinking', text: 'STAGE_DONE:42:testing' },
      { seq: 4, role: 'tool_use', tool: 'Bash', input: '{}' },
    ];
    const texts = extractAssistantTexts(msgs);
    expect(texts).toEqual(['STAGE_DONE:42:testing']);
  });

  test('tool_result 里出现哨兵（grep 旧 prompt / cat 日志）永远进不来', () => {
    const msgs: ChatMessage[] = [
      { seq: 0, role: 'tool_result', result: 'grep 到：ISSUE_BLOCKED:42 假的' },
    ];
    expect(extractAssistantTexts(msgs)).toEqual([]);
  });
});

describe('哨兵矩阵：NEED_CLARIFY 整行匹配 + 核 id', () => {
  test('正例：整行命中（首尾空白/宽容空格）', () => {
    expect(findNeedClarify('问题如下\n1. 用哪个库？\nNEED_CLARIFY:42', ID)).toBe(true);
    expect(findNeedClarify('  NEED_CLARIFY: 42  ', ID)).toBe(true);
  });
  test('错 id / 子串 / 占位符 = 拒（与其它哨兵同纪律）', () => {
    expect(findNeedClarify('NEED_CLARIFY:43', ID)).toBe(false);
    expect(findNeedClarify('NEED_CLARIFY:420', ID)).toBe(false);
    expect(findNeedClarify('必要时我会输出 NEED_CLARIFY:42 这一行', ID)).toBe(false);
    expect(findNeedClarify('- NEED_CLARIFY:42', ID)).toBe(false);
    expect(findNeedClarify('NEED_CLARIFY:<id>', ID)).toBe(false);
  });
});

describe('parseClarifyQuestions：从编号清单抽问题（口径同 clarify-runner）', () => {
  test('只取编号/列表项、剥前缀、跳散文与哨兵行', () => {
    const t = [
      '后台调研已回，确认了几点：', // 散文，跳过
      '1. 流程节点只展示 L3-L5 吗？',
      '2) 下线按钮改蓝色可以吗？',
      '3、部署走当前分支对吗？',
      'NEED_CLARIFY:42', // 哨兵行，跳过
    ].join('\n');
    expect(parseClarifyQuestions(t)).toEqual([
      '流程节点只展示 L3-L5 吗？',
      '下线按钮改蓝色可以吗？',
      '部署走当前分支对吗？',
    ]);
  });
  test('无编号（纯散文）→ 空数组；「无」类占位跳过', () => {
    expect(parseClarifyQuestions('我这边没有需要澄清的，继续实施。')).toEqual([]);
    expect(parseClarifyQuestions('1. 无')).toEqual([]);
  });
  test('上限 10 条、单条 1000 字', () => {
    const many = Array.from({ length: 14 }, (_, i) => `${i + 1}. q${i}`).join('\n');
    expect(parseClarifyQuestions(many).length).toBe(10);
    expect(parseClarifyQuestions(`1. ${'字'.repeat(1200)}`)[0]!.length).toBe(1000);
  });
  test('块级：A/B/C 子选项与缩进续行并入同一条，空行断开（#110）', () => {
    const t = [
      '读完了相关代码，现状是这样的：',
      '- 现状一：没有档位',
      '',
      '1. 档位存在哪一层？',
      '   A. 挂在对话上；',
      '   B. issue 一份 + 对话一份。',
      '',
      '2. 三档的语义：',
      '   谨慎 = 都等我点；',
      '   全自动 = 全批。',
      '',
      '默认值我自己定了不问你：沿用现状。', // 清单后的散文段，不并入第 2 条
      '',
      'NEED_CLARIFY:42',
    ].join('\n');
    expect(parseClarifyQuestions(t)).toEqual([
      '现状一：没有档位',
      '档位存在哪一层？\nA. 挂在对话上；\nB. issue 一份 + 对话一份。',
      '三档的语义：\n谨慎 = 都等我点；\n全自动 = 全批。',
    ]);
  });
});

describe('extractClarifyText：原文留档（#110）', () => {
  test('剔哨兵行 + trim；散文与续行全保留', () => {
    const t = '\n现状是这样的：\n1. 档位放哪层？\n   A. 对话上\n\nNEED_CLARIFY:42\n';
    expect(extractClarifyText(t)).toBe('现状是这样的：\n1. 档位放哪层？\n   A. 对话上');
  });
  test('截 4000 字', () => {
    expect(extractClarifyText('字'.repeat(5000)).length).toBe(MAX_CLARIFY_TEXT_CHARS);
  });
});

describe('SUBTASKS 块：BEGIN/END 各自独占一行', () => {
  test('正例：解析 + 去序号 + 清洗', () => {
    const t = `拆解如下：\nSUBTASKS_BEGIN\n1. 写解析器\n2) 加测试\n- 3、补文档\n\nSUBTASKS_END\n以上`;
    expect(parseSubtasksBlock(t)).toEqual(['写解析器', '加测试', '补文档']);
  });
  test('复述格式说明（同行有别的字）不触发 —— v1 提前置 ready 修复', () => {
    expect(parseSubtasksBlock('我会输出 SUBTASKS_BEGIN 然后每行一个 SUBTASKS_END 结束')).toBeNull();
    expect(parseSubtasksBlock('先一行 SUBTASKS_BEGIN，最后一行 SUBTASKS_END。')).toBeNull();
  });
  test('缺 END / 空块 → null；上限 40 条、单条 500 字', () => {
    expect(parseSubtasksBlock('SUBTASKS_BEGIN\n1. x')).toBeNull();
    expect(parseSubtasksBlock('SUBTASKS_BEGIN\nSUBTASKS_END')).toBeNull();
    const many = `SUBTASKS_BEGIN\n${Array.from({ length: 50 }, (_, i) => `${i + 1}. t${i}`).join('\n')}\nSUBTASKS_END`;
    expect(parseSubtasksBlock(many)!.length).toBe(40);
    const long = `SUBTASKS_BEGIN\n1. ${'x'.repeat(600)}\nSUBTASKS_END`;
    expect(parseSubtasksBlock(long)![0]!.length).toBe(500);
  });
});

describe('limit 识别（收紧版）', () => {
  test('命中 v1 家族关键词', () => {
    expect(looksRateLimited('You have hit your usage limit.')).toBe(true);
    expect(looksRateLimited('rate limit exceeded')).toBe(true);
  });
  test('codex session limit 措辞（issue #48 生产实录）', () => {
    expect(looksRateLimited("You've hit your session limit · resets 5:50am (UTC)")).toBe(true);
    expect(looksRateLimited("You've hit your weekly limit.")).toBe(true);
    expect(looksRateLimited('you hit your limit')).toBe(true);
  });
  test('去掉过宽的 resets at（评审 M1 误伤修复）；普通 limit 叙述不误伤', () => {
    expect(looksRateLimited('the counter resets at midnight')).toBe(false);
    expect(looksRateLimited('we should limit retries to 3')).toBe(false);
    expect(looksRateLimited('该函数对输入做了 limit 截断')).toBe(false);
  });
});

describe('完成报告块 REPORT_BEGIN / REPORT_END（#275 / I-05）', () => {
  const report = {
    version: 1,
    outcome: 'complete',
    objective: '目标',
    implementation: ['做了 A'],
    advantages: ['快'],
    disadvantages: [],
    verification: ['跑了测试'],
    completion: '已完成',
    unmetGoals: [],
    remainingWork: [],
  };
  const wrap = (body: string) => `STAGE_DONE:42:testing\nREPORT_BEGIN\n${body}\nREPORT_END\n收工`;

  test('随 STAGE_DONE 一并带出时能解析，字段照原样落下来', () => {
    const r = parseCompletionReportBlock(wrap(JSON.stringify(report, null, 2)));
    expect(r).toMatchObject({ outcome: 'complete', objective: '目标', implementation: ['做了 A'] });
  });

  test('两个标记必须各自独占一行：写在句中不算', () => {
    expect(parseCompletionReportBlock(`前面 REPORT_BEGIN ${JSON.stringify(report)} REPORT_END`)).toBeNull();
    expect(parseCompletionReportBlock(`REPORT_BEGIN\n${JSON.stringify(report)}`)).toBeNull(); // 缺 END
    expect(parseCompletionReportBlock('毫无关系的一段话')).toBeNull();
  });

  test('非法内容一律返回 null 由调用方忽略，不抛错', () => {
    expect(parseCompletionReportBlock(wrap('{坏 JSON'))).toBeNull();
    expect(parseCompletionReportBlock(wrap('{"version":2}'))).toBeNull();      // 版本不符
    expect(parseCompletionReportBlock(wrap(JSON.stringify({ ...report, outcome: 'x' })))).toBeNull();
    expect(parseCompletionReportBlock(wrap(''))).toBeNull();                    // 空块
  });

  test('超长块直接拒收，避免把整屏日志当 JSON 解', () => {
    const fat = JSON.stringify({ ...report, objective: 'x'.repeat(40_000) });
    expect(parseCompletionReportBlock(wrap(fat))).toBeNull();
  });
});
