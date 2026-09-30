/**
 * lib/pathlink 单测（issue #310）。
 * 重点在「宁可漏认、不可误伤」：正文里的比值、日期、网址、纯目录名都不该变成文件链接，
 * 且切片拼回来必须与原文逐字相同。
 */
import { describe, expect, test } from 'bun:test';
import {
  filesHref,
  filesRouteParam,
  isLikelyPath,
  looksLikeFsPath,
  resolveProjectPath,
  routeTarget,
  splitPathChunks,
} from './pathlink';

const CWD = '/home/developer/workspace/proj';

describe('splitPathChunks', () => {
  test('切片拼回来与原文逐字相同', () => {
    const cases = [
      '见 docs/a.md 与 /home/developer/workspace/proj/x.ts。',
      '命中率 62/121，另有 51.56% 未覆盖',
      '没有任何路径的一段中文正文',
      'and/or 之类的写法不该被认成路径',
    ];
    for (const text of cases) {
      expect(splitPathChunks(text).map((c) => c.text).join('')).toBe(text);
    }
  });

  test('认出绝对路径与带扩展名的相对路径', () => {
    const chunks = splitPathChunks('报告在 /home/developer/proj/docs/a.md，代码见 src/web/routes/files.ts');
    expect(chunks.filter((c) => c.path).map((c) => c.path)).toEqual([
      '/home/developer/proj/docs/a.md',
      'src/web/routes/files.ts',
    ]);
  });

  test('句读不算进路径', () => {
    const chunks = splitPathChunks('详见 docs/a.md。');
    expect(chunks.find((c) => c.path)?.path).toBe('docs/a.md');
    expect(chunks.map((c) => c.text).join('')).toBe('详见 docs/a.md。');
  });

  test('比值 / 日期 / issue 编号 / 域名都不认', () => {
    for (const text of ['62/121', '2026/07/23', 'issue/310', 'example.com/a.html', '1.5/2.0']) {
      expect(splitPathChunks(text).some((c) => c.path)).toBe(false);
    }
  });

  test('网址里的路径段不认（前面粘着的是 url 的一部分）', () => {
    expect(splitPathChunks('见 https://example.com/a/b.html').some((c) => c.path)).toBe(false);
  });

  test('以 . 开头的目录（.panda/modules/INDEX.md）照样认', () => {
    expect(splitPathChunks('读 .panda/modules/INDEX.md').find((c) => c.path)?.path)
      .toBe('.panda/modules/INDEX.md');
  });

  test('带尾斜杠的目录不要求扩展名', () => {
    expect(splitPathChunks('产物在 runs/full-field-audit/ 下').find((c) => c.path)?.path)
      .toBe('runs/full-field-audit/');
  });
});

describe('isLikelyPath', () => {
  test('相对路径必须 ≥2 段且末段带含字母的扩展名', () => {
    expect(isLikelyPath('a.md')).toBe(false); // 单段：没有斜杠不认
    expect(isLikelyPath('docs/a.md')).toBe(true);
    expect(isLikelyPath('docs/readme')).toBe(false);
    expect(isLikelyPath('a/2.0')).toBe(false);
  });

  test('绝对路径不看扩展名（归属判定交给 resolveProjectPath）', () => {
    expect(isLikelyPath('/home/developer/proj/runs')).toBe(true);
  });
});

describe('resolveProjectPath', () => {
  test('cwd 内的绝对路径换算成相对路径', () => {
    expect(resolveProjectPath(`${CWD}/runs/audit.html`, CWD)).toEqual({
      rel: 'runs/audit.html',
      dir: false,
    });
  });

  test('cwd 尾斜杠不影响归属判定', () => {
    expect(resolveProjectPath(`${CWD}/a.md`, `${CWD}/`)).toEqual({ rel: 'a.md', dir: false });
  });

  test('cwd 外的绝对路径一律不给链接', () => {
    expect(resolveProjectPath('/home/developer/workspace/other/a.md', CWD)).toBeNull();
    // 前缀相同但不是同一目录（proj-old ≠ proj）也必须拒绝
    expect(resolveProjectPath('/home/developer/workspace/proj-old/a.md', CWD)).toBeNull();
  });

  test('cwd 本身 = 项目根目录', () => {
    expect(resolveProjectPath(CWD, CWD)).toEqual({ rel: '', dir: true });
    expect(resolveProjectPath(`${CWD}/`, CWD)).toEqual({ rel: '', dir: true });
  });

  test('相对路径按 cwd 相对解释，`./` 前缀去掉', () => {
    expect(resolveProjectPath('./docs/a.md', CWD)).toEqual({ rel: 'docs/a.md', dir: false });
    expect(resolveProjectPath('docs/', CWD)).toEqual({ rel: 'docs', dir: true });
  });

  test('带协议头 / 锚点的 href 不是路径（markdown 链接目标直接进这里）', () => {
    expect(resolveProjectPath('https://a.com/b', CWD)).toBeNull();
    expect(resolveProjectPath('mailto:a@b.com', CWD)).toBeNull();
    expect(resolveProjectPath('#/p/3/files', CWD)).toBeNull();
    expect(resolveProjectPath('//cdn.example.com/x.js', CWD)).toBeNull();
  });

  test('`..` 逃逸一律拒绝', () => {
    expect(resolveProjectPath('../other/a.md', CWD)).toBeNull();
    expect(resolveProjectPath(`${CWD}/../other/a.md`, CWD)).toBeNull();
  });
});

describe('路由参数', () => {
  test('文件/目录 → 深链（目录带尾斜杠，整体转义）', () => {
    expect(filesHref(3, { rel: 'runs/audit.html', dir: false })).toBe(
      '#/p/3/workspace/files/runs%2Faudit.html',
    );
    expect(filesHref(3, { rel: 'runs', dir: true })).toBe('#/p/3/workspace/files/runs%2F');
    expect(filesHref(3, { rel: '', dir: true })).toBe('#/p/3/workspace');
  });

  test('深链参数 → 目标（与 filesRouteParam 互为逆）', () => {
    for (const target of [
      { rel: 'runs/audit.html', dir: false },
      { rel: 'runs', dir: true },
    ]) {
      expect(routeTarget(filesRouteParam(target))).toEqual(target);
    }
  });

  test('畸形/越界参数按「没带路径」处理', () => {
    expect(routeTarget('')).toBeNull();
    expect(routeTarget(undefined)).toBeNull();
    expect(routeTarget('../etc/passwd')).toBeNull();
  });
});

describe('looksLikeFsPath', () => {
  test('认本机文件系统路径，不误伤站内路由', () => {
    expect(looksLikeFsPath('/home/developer/a.md')).toBe(true);
    expect(looksLikeFsPath('/p/3/files')).toBe(false);
    expect(looksLikeFsPath('#/p/3/files')).toBe(false);
  });
});
