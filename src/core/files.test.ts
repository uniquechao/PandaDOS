/**
 * core/files 单测 —— 文件浏览模块的纯函数：
 * resolveProjectPath（cwd 内限定，防穿越）× safeFsFileName（上传名净化）× isProbablyBinary。
 */
import { describe, expect, test } from 'bun:test';
import {
  contentTypeForExt,
  isProbablyBinary,
  isScriptableType,
  resolveProjectPath,
  safeFsFileName,
} from './files';

describe('resolveProjectPath', () => {
  const cwd = '/data/ws/proj';

  test('空串与 . 都解析为 cwd 本身', () => {
    expect(resolveProjectPath(cwd, '')).toBe(cwd);
    expect(resolveProjectPath(cwd, '.')).toBe(cwd);
    expect(resolveProjectPath(cwd, './')).toBe(cwd);
  });

  test('常规相对路径拼在 cwd 下', () => {
    expect(resolveProjectPath(cwd, 'a')).toBe('/data/ws/proj/a');
    expect(resolveProjectPath(cwd, 'a/b.txt')).toBe('/data/ws/proj/a/b.txt');
    expect(resolveProjectPath(cwd, './a/./b')).toBe('/data/ws/proj/a/b');
  });

  test('内部 .. 折叠后仍在 cwd 内则放行', () => {
    expect(resolveProjectPath(cwd, 'a/../b')).toBe('/data/ws/proj/b');
  });

  test('越界 .. 一律拒绝（null）', () => {
    expect(resolveProjectPath(cwd, '..')).toBeNull();
    expect(resolveProjectPath(cwd, '../x')).toBeNull();
    expect(resolveProjectPath(cwd, 'a/../../x')).toBeNull();
    expect(resolveProjectPath(cwd, 'a/../..')).toBeNull();
  });

  test('前缀相似目录不算 cwd 内（/data/ws/proj2 ≠ /data/ws/proj）', () => {
    expect(resolveProjectPath(cwd, '../proj2/f')).toBeNull();
  });

  test('绝对路径拒绝', () => {
    expect(resolveProjectPath(cwd, '/etc/passwd')).toBeNull();
  });

  test('反斜杠按分隔符处理，防 Windows 风格穿越', () => {
    expect(resolveProjectPath(cwd, '..\\..\\etc')).toBeNull();
    expect(resolveProjectPath(cwd, 'a\\b')).toBe('/data/ws/proj/a/b');
  });

  test('NUL 字节拒绝', () => {
    expect(resolveProjectPath(cwd, 'a\0b')).toBeNull();
  });
});

describe('safeFsFileName', () => {
  test('常规文件名保留（含中文/空格/无扩展名）', () => {
    expect(safeFsFileName('a.txt')).toBe('a.txt');
    expect(safeFsFileName('设计 稿.md')).toBe('设计 稿.md');
    expect(safeFsFileName('Makefile')).toBe('Makefile');
  });

  test('路径分量剥掉只留基名', () => {
    expect(safeFsFileName('dir/a.txt')).toBe('a.txt');
    expect(safeFsFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFsFileName('c:\\win\\x.exe')).toBe('x.exe');
  });

  test('控制字符去除、超长截断 200', () => {
    expect(safeFsFileName('a\x00\x1fb.txt')).toBe('ab.txt');
    expect(safeFsFileName('x'.repeat(300))!.length).toBe(200);
  });

  test('空/纯点名拒绝（null）', () => {
    expect(safeFsFileName('')).toBeNull();
    expect(safeFsFileName('.')).toBeNull();
    expect(safeFsFileName('..')).toBeNull();
    expect(safeFsFileName('dir/')).toBeNull();
  });
});

describe('isProbablyBinary', () => {
  test('普通 UTF-8 文本 → false', () => {
    expect(isProbablyBinary(new TextEncoder().encode('hello 世界\n'))).toBe(false);
    expect(isProbablyBinary(new Uint8Array(0))).toBe(false);
  });

  test('含 NUL 字节 → true', () => {
    expect(isProbablyBinary(new Uint8Array([0x68, 0x00, 0x69]))).toBe(true);
  });
});

describe('contentTypeForExt', () => {
  test('图片/网页/PDF/代码扩展名映射（大小写不敏感）', () => {
    expect(contentTypeForExt('a.png')).toBe('image/png');
    expect(contentTypeForExt('A.JPG')).toBe('image/jpeg');
    expect(contentTypeForExt('logo.svg')).toBe('image/svg+xml');
    expect(contentTypeForExt('index.html')).toBe('text/html; charset=utf-8');
    expect(contentTypeForExt('main.js')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeForExt('data.json')).toBe('application/json; charset=utf-8');
    expect(contentTypeForExt('report.pdf')).toBe('application/pdf');
    expect(contentTypeForExt('notes.md')).toBe('text/plain; charset=utf-8');
  });

  test('无扩展名/未知 → application/octet-stream', () => {
    expect(contentTypeForExt('README')).toBe('application/octet-stream');
    expect(contentTypeForExt('a.unknownext')).toBe('application/octet-stream');
    expect(contentTypeForExt('archive.tar.gz')).toBe('application/octet-stream');
  });
});

describe('isScriptableType', () => {
  test('html/svg → true（需 CSP sandbox 兜底）', () => {
    expect(isScriptableType('text/html; charset=utf-8')).toBe(true);
    expect(isScriptableType('image/svg+xml')).toBe(true);
  });
  test('图片/PDF/文本 → false', () => {
    expect(isScriptableType('image/png')).toBe(false);
    expect(isScriptableType('application/pdf')).toBe(false);
    expect(isScriptableType('text/plain; charset=utf-8')).toBe(false);
  });
});
