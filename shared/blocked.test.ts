import { describe, expect, test } from 'bun:test';
import { parseBlockedNote } from './blocked';

describe('parseBlockedNote', () => {
  test('三段齐全（全角分隔）拆成在做/卡在/要你做什么', () => {
    expect(parseBlockedNote('在给 UI 加受阻面板｜本机没装 chromium，跑不了浏览器自测｜请在执行机上装一下 chromium')).toEqual({
      doing: '在给 UI 加受阻面板',
      stuck: '本机没装 chromium，跑不了浏览器自测',
      action: '请在执行机上装一下 chromium',
    });
  });

  test('半角 | 与前后空格同样认', () => {
    expect(parseBlockedNote(' 改数据库迁移 | 缺写权限 | 给 ~/.panda 目录加写权限 ')).toEqual({
      doing: '改数据库迁移',
      stuck: '缺写权限',
      action: '给 ~/.panda 目录加写权限',
    });
  });

  test('段内自带标签时剥掉，避免与 UI 标签重复', () => {
    expect(parseBlockedNote('在做：接第三方接口｜卡在：缺 API Key｜要我做什么：把 key 写进 /root/.panda/env')).toEqual({
      doing: '接第三方接口',
      stuck: '缺 API Key',
      action: '把 key 写进 /root/.panda/env',
    });
  });

  test('多于三段时多余的并回最后一段（正文本来就带竖线不判废）', () => {
    expect(parseBlockedNote('跑门禁｜typecheck 报错｜先执行 a｜再执行 b')).toEqual({
      doing: '跑门禁',
      stuck: 'typecheck 报错',
      action: '先执行 a｜再执行 b',
    });
  });

  test('不足三段、有空段、空值一律返回 null（退回展示原句）', () => {
    expect(parseBlockedNote('执行工作区不可用')).toBeNull();
    expect(parseBlockedNote('装依赖失败｜没网')).toBeNull();
    expect(parseBlockedNote('在做事｜｜要你处理')).toBeNull();
    expect(parseBlockedNote('在做事｜卡住了｜要我做什么：')).toBeNull();
    expect(parseBlockedNote('')).toBeNull();
    expect(parseBlockedNote(null)).toBeNull();
    expect(parseBlockedNote(undefined)).toBeNull();
  });
});
