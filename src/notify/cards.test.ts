import { describe, expect, test } from 'bun:test';
import {
  GATE_SUMMARY_MAX,
  buildEventCard,
  buildGateCard,
  buildReplyCard,
  buildSelectionCard,
  gateSummary,
  isEventStatus,
} from './cards';
import { createI18n } from '../../shared/i18n/formatter';
import { enCatalog } from '../../shared/i18n/catalogs/en';

const en = createI18n({ locale: 'en', timeZone: 'UTC', catalog: enCatalog });

// 卡片是 unknown（喂飞书 SDK 的裸 JSON），测试里按结构断言
/* eslint-disable @typescript-eslint/no-explicit-any */
type Card = any;

function actions(card: Card): Card[] {
  const el = card.elements.find((e: Card) => e.tag === 'action');
  return el ? el.actions : [];
}

describe('三卡平移（v1 结构保持）', () => {
  test('isEventStatus 校验 LLM 输出', () => {
    expect(isEventStatus('working')).toBe(true);
    expect(isEventStatus('done')).toBe(true);
    expect(isEventStatus('bogus')).toBe(false);
    expect(isEventStatus(42)).toBe(false);
  });

  test('事件卡：彩头 + headline + needsReply 提示行', () => {
    const c = buildEventCard(en, 'proj-a', 'error', 'build failed', true) as Card;
    expect(c.header.template).toBe('red');
    expect(c.header.title.content).toContain('proj-a');
    expect(c.elements[0].text.content).toBe('build failed');
    expect(JSON.stringify(c)).toContain('Waiting for your reply');
    // 不带 needsReply 时无提示行
    const c2 = buildEventCard(en, 'proj-a', 'done', 'ok') as Card;
    expect(JSON.stringify(c2)).not.toContain('Waiting for your reply');
  });

  test('回复卡：单 lark_md div', () => {
    const c = buildReplyCard('**hi**') as Card;
    expect(c.elements).toHaveLength(1);
    expect(c.elements[0].text.tag).toBe('lark_md');
  });

  test('选择卡：≤6 按钮、18 字截断、首项 primary、value 协议', () => {
    const opts = ['短', 'x'.repeat(30), '3', '4', '5', '6', '第七项不出按钮'];
    const c = buildSelectionCard(en, 'req1', 's1', 'summary', opts) as Card;
    const btns = actions(c);
    expect(btns).toHaveLength(6);
    expect(btns[0].type).toBe('primary');
    expect(btns[1].type).toBe('default');
    expect(btns[1].text.content.length).toBeLessThanOrEqual('2. '.length + 19); // 18 字 + …
    expect(btns[2].value).toEqual({ forge: 'selection', requestId: 'req1', optionIndex: 2 });
  });
});

describe('卡点确认卡（新增）', () => {
  test('approve/reject 双按钮共用同一 requestId，forge=gate', () => {
    const c = buildGateCard({ requestId: 'gX', kind: 'plan', issueId: 7, summary: 'S' }, en) as Card;
    expect(c.header.title.content).toContain('Plan awaiting confirmation');
    expect(c.header.title.content).toContain('#7');
    const btns = actions(c);
    expect(btns).toHaveLength(2);
    expect(btns[0].value).toEqual({ forge: 'gate', requestId: 'gX', action: 'approve' });
    expect(btns[1].value).toEqual({ forge: 'gate', requestId: 'gX', action: 'reject' });
    expect(btns[0].type).toBe('primary');
    expect(btns[1].type).toBe('danger');
  });

  test('merge_review 标题', () => {
    const c = buildGateCard({ requestId: 'g', kind: 'merge_review', issueId: 3, summary: 'S' }, en) as Card;
    expect(c.header.title.content).toContain('Pre-merge review');
  });
});

describe('gateSummary', () => {
  test('plan：编号清单 + 实现模式', () => {
    const s = gateSummary('plan', JSON.stringify({ subtasks: ['做A', '做B'], implMode: 'seq' }), en);
    expect(s).toContain('Plan (2 steps');
    expect(s).toContain('1. 做A');
    expect(s).toContain('2. 做B');
    expect(s).toContain('seq');
  });

  test('plan：超 15 条截断、超长条目截断', () => {
    const subtasks = Array.from({ length: 20 }, (_, i) => (i === 0 ? 'x'.repeat(200) : `t${i}`));
    const s = gateSummary('plan', JSON.stringify({ subtasks, implMode: 'team' }), en);
    expect(s).toContain('20 steps total');
    expect(s).not.toContain('t16'); // 第 17 条不出现
    expect(s).toContain('x'.repeat(80) + '…'); // 条目截 80
    expect(s).toContain('team');
  });

  test('plan：空计划兜底', () => {
    expect(gateSummary('plan', JSON.stringify({ subtasks: [] }), en)).toContain('web app');
    expect(gateSummary('plan', null, en)).toContain('web app');
  });

  test('merge_review：分支 + stat + 截断提示 + gitError', () => {
    const s = gateSummary(
      'merge_review',
      JSON.stringify({
        branch: 'issue/5',
        base: 'main',
        stat: ' a.ts | 2 +-\n 1 file changed',
        diffTruncated: true,
        gitError: 'boom',
      }), en,
    );
    expect(s).toContain('`issue/5` → `main`');
    expect(s).toContain('1 file changed');
    expect(s).toContain('truncated');
    expect(s).toContain('boom');
    expect(s).toContain('web app');
  });

  test('payload 畸形 JSON 不炸，兜底可读', () => {
    const s = gateSummary('merge_review', '{oops', en);
    expect(s).toContain('web app');
  });

  test('总长封顶 GATE_SUMMARY_MAX', () => {
    const s = gateSummary('merge_review', JSON.stringify({ branch: 'b', base: 'm', stat: 'y'.repeat(99999) }), en);
    expect(s.length).toBeLessThanOrEqual(GATE_SUMMARY_MAX + 1); // +… 一枚
  });
});
