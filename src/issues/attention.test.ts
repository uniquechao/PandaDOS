/**
 * issues/attention 单测（#275 / I-07）——纯函数，入参普通数据。
 * 重点在**优先级**与两条本地判据（stalled / verify），这两条是把 27 次错误 blocked 拆开的关键。
 */
import { describe, expect, test } from 'bun:test';
import type { IssueState } from '../core/types';
import { attentionKindOf, looksLikeVerifyNote, type AttentionEvent } from './attention';

let seq = 0;
const ev = (kind: string, data?: Record<string, unknown>): AttentionEvent => ({
  id: ++seq,
  kind,
  dataJson: data ? JSON.stringify(data) : null,
});
const blockedTransition = (note: string, extra: Record<string, unknown> = {}) =>
  ev('transition', { event: 'block', from: 'implementing', to: 'blocked', note, ...extra });

const kindOf = (
  status: IssueState,
  events: AttentionEvent[] = [],
  flags: { clarifyPending?: boolean; waitingInput?: boolean } = {},
) => attentionKindOf({
  status,
  events,
  clarifyPending: flags.clarifyPending ?? false,
  waitingInput: flags.waitingInput ?? false,
});

describe('attentionKindOf：不用你管的情况', () => {
  test('终态恒 none，哪怕还留着旧标记', () => {
    seq = 0;
    for (const s of ['done', 'cancelled'] as IssueState[]) {
      expect(kindOf(s, [blockedTransition('随便')], { clarifyPending: true, waitingInput: true })).toBe('none');
    }
  });

  test('正常跑着、没人在等 → none', () => {
    seq = 0;
    expect(kindOf('implementing', [ev('nudged')])).toBe('none');
    expect(kindOf('pending')).toBe('none');
  });
});

describe('attentionKindOf：顺序即优先级', () => {
  test('clarify 压过一切——你此刻一句话就能解开它', () => {
    seq = 0;
    const events = [ev('nudge_exhausted', { count: 5 }), blockedTransition('缺依赖')];
    expect(kindOf('blocked', events, { clarifyPending: true, waitingInput: true })).toBe('clarify');
  });

  test('choice 压过 review / stalled / blocked', () => {
    seq = 0;
    expect(kindOf('merge_review', [], { waitingInput: true })).toBe('choice');
    expect(kindOf('implementing', [ev('judge_exhausted')], { waitingInput: true })).toBe('choice');
  });

  test('卡点状态 → review', () => {
    seq = 0;
    expect(kindOf('plan_review')).toBe('review');
    expect(kindOf('merge_review')).toBe('review');
  });

  test('stalled 压过 blocked：说得更准的盖过说得更泛的', () => {
    seq = 0;
    // #274 止损暂停：状态是 blocked，但那次 transition 带 stopLoss 标记
    expect(kindOf('blocked', [blockedTransition('止损暂停：累计受阻 3 次', { stopLoss: true })]))
      .toBe('stalled');
  });
});

describe('attentionKindOf：stalled 认两种「自动手段用尽」', () => {
  test('#274 止损暂停与 #273 自动重试到顶共用同一取值', () => {
    seq = 0;
    expect(kindOf('blocked', [blockedTransition('止损暂停：跑太久', { stopLoss: true })])).toBe('stalled');
    seq = 0;
    expect(kindOf('implementing', [ev('nudge_exhausted', { count: 5 })])).toBe('stalled');
    seq = 0;
    expect(kindOf('testing', [ev('judge_exhausted', { count: 10 })])).toBe('stalled');
  });

  test('人工介入之后的旧标记不再算数，否则解开过的 issue 会永远挂着', () => {
    seq = 0;
    const events = [ev('nudge_exhausted', { count: 5 }), ev('unblock_guidance', { guidance: '继续' })];
    expect(kindOf('implementing', events)).toBe('none');
    seq = 0;
    expect(kindOf('implementing', [ev('judge_exhausted'), ev('clarified')])).toBe('none');
  });

  test('普通 blocked 不是 stalled', () => {
    seq = 0;
    expect(kindOf('blocked', [blockedTransition('缺少 API key')])).toBe('blocked');
  });
});

describe('attentionKindOf：verify 把「只差人工验收」从故障里摘出来', () => {
  test('本地门禁过了 + note 提到部署/真机/验收 → verify', () => {
    for (const note of [
      '需人工在低峰执行 systemctl restart panda 才生效',
      '本地门禁全过，等真机验收',
      'Needs a manual deploy before it can be verified',
    ]) {
      seq = 0;
      const events = [ev('auto_commit', {}), ev('auto_push', { branch: 'main' }), blockedTransition(note)];
      expect(kindOf('blocked', events)).toBe('verify');
    }
  });

  test('门禁没过（有测试失败）→ 还是 blocked，不能说成等验收', () => {
    seq = 0;
    const events = [ev('auto_commit', {}), ev('tests_failed', { note: '3 个挂了' }), blockedTransition('等部署验收')];
    expect(kindOf('blocked', events)).toBe('blocked');
  });

  test('没有任何交付痕迹 → 还是 blocked（光说要部署不算数）', () => {
    seq = 0;
    expect(kindOf('blocked', [blockedTransition('等部署')])).toBe('blocked');
  });

  test('note 不提验收类字眼 → blocked（误判方向刻意保守）', () => {
    seq = 0;
    const events = [ev('auto_commit', {}), ev('auto_push', {}), blockedTransition('Author identity unknown')];
    expect(kindOf('blocked', events)).toBe('blocked');
  });

  test('无远端跳过推送也算交付痕迹（push_skipped 不是故障）', () => {
    seq = 0;
    const events = [ev('auto_commit', {}), ev('push_skipped', { reason: 'no-remote' }), blockedTransition('等人工验收')];
    expect(kindOf('blocked', events)).toBe('verify');
  });

  test('只看最近一次 blocked 的 note，不被历史那次带偏', () => {
    seq = 0;
    const events = [
      ev('auto_commit', {}),
      blockedTransition('等部署验收'),      // 旧的一次
      ev('unblock_guidance', { guidance: '继续' }),
      ev('auto_commit', {}),
      blockedTransition('缺少凭据'),        // 最近一次是真故障
    ];
    expect(kindOf('blocked', events)).toBe('blocked');
  });
});

describe('looksLikeVerifyNote', () => {
  test('中英关键词都认，无关文本不认', () => {
    expect(looksLikeVerifyNote('需要重启服务')).toBe(true);
    expect(looksLikeVerifyNote('waiting for manual sign-off')).toBe(true);
    expect(looksLikeVerifyNote('依赖装不上')).toBe(false);
    expect(looksLikeVerifyNote('')).toBe(false);
  });
});

describe('attentionKindOf：坏数据不拖垮派生', () => {
  test('transition 数据损坏时当没有这条', () => {
    seq = 0;
    const events: AttentionEvent[] = [{ id: 1, kind: 'transition', dataJson: '{坏' }];
    expect(kindOf('blocked', events)).toBe('blocked'); // 退回最保守的说法
  });
});

describe('attentionKindOf：已排队待恢复不再喊「等你处理」（#283 / B-10）', () => {
  test('blocked + 已排队 → none：用户该做的已经做了，系统会自动接手', () => {
    seq = 0;
    const events = [blockedTransition('缺依赖')];
    expect(kindOf('blocked', events)).toBe('blocked');
    expect(attentionKindOf({
      status: 'blocked', events, clarifyPending: false, waitingInput: false, unblockQueued: true,
    })).toBe('none');
  });

  test('止损暂停同理：排上队之后不再算 stalled', () => {
    seq = 0;
    const events = [blockedTransition('止损暂停', { stopLoss: true })];
    expect(kindOf('blocked', events)).toBe('stalled');
    expect(attentionKindOf({
      status: 'blocked', events, clarifyPending: false, waitingInput: false, unblockQueued: true,
    })).toBe('none');
  });

  test('真正需要人的两件事仍然压过它：澄清与弹窗选择', () => {
    seq = 0;
    const events = [blockedTransition('缺依赖')];
    expect(attentionKindOf({
      status: 'blocked', events, clarifyPending: true, waitingInput: false, unblockQueued: true,
    })).toBe('clarify');
    expect(attentionKindOf({
      status: 'blocked', events, clarifyPending: false, waitingInput: true, unblockQueued: true,
    })).toBe('choice');
  });

  test('缺省不传 unblockQueued 时行为完全不变', () => {
    seq = 0;
    expect(kindOf('blocked', [blockedTransition('缺依赖')])).toBe('blocked');
  });
});
