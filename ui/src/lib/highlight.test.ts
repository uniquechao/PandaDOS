import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  codeLines,
  langOfPath,
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINES,
  splitLines,
  tokenize,
  withinHighlightLimit,
  type LangId,
  type Token,
} from './highlight';
import { previewKind } from './preview';

const join = (ts: Token[]): string => ts.map((t) => t.text).join('');
/** 取某类型的全部 token 文本 */
const of = (ts: Token[], type: Token['type']): string[] => ts.filter((t) => t.type === type).map((t) => t.text);

const SAMPLES: Record<LangId, string> = {
  js: "import x from 'y';\n// c\nconst a = `t ${b}` + 1.5e3; /* b */\nfoo(a);",
  json: '{\n  "name": "panda",\n  "n": 1,\n  "ok": true, "z": null\n}',
  python: '@dataclass\ndef f(x):\n    """doc\n    more"""\n    return rb"x" + None  # c',
  go: 'package main\n\nfunc main() {\n\ts := `raw\nline`\n\tfmt.Println(len(s), nil)\n}',
  java: '@Override\npublic static void main(String[] a) { int n = 0x1F; }',
  c: '#include <stdio.h>\n  #define X 1\nint main() { return 0; }',
  bash: '#!/bin/bash\n# comment\necho "$HOME ${USER}" $# --flag \'lit\'\nif [ -f x ]; then exit 1; fi',
  bat: '@echo off\nREM hello\n:: note\n:start\nset X=%PATH%\nif exist "a b" goto start',
  sql: "\\set ON_ERROR_STOP on\n-- c\nSELECT id, \"Name\" FROM t WHERE x = 'it''s' AND y = $1;\nCREATE FUNCTION f() RETURNS int AS $$ select 1 $$ LANGUAGE sql;",
  yaml: '---\nname: ci # c\njobs:\n  build:\n    - run: "echo"\n      if: true\n    - other: &a 1',
  ini: '; c\n[section]\nkey = value\n  indented.key: 42\nexport TOKEN=abc',
  toml: '# c\n[tool.x]\nname = "p"\n  ver = 1.2\ndate = 2026-09-23\n[[bin]]',
  css: '/* c */\n.a:hover { color: #fff; --x: 2px; }\n@media (max-width: 600px) { .b { margin: 0 } }',
  xml: '<?xml version="1.0"?>\n<!-- c -->\n<a href="x" data-y=\'1\'>t &amp; <b/></a>',
  dockerfile: 'FROM node:20 AS build\n# c\n  RUN npm ci --omit=dev\nENV A=$B',
  makefile: 'all: build\n\tgo build $(FLAGS) $@\n# c',
  diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n ctx',
  ruby: "def f(a)\n  @x = :sym # c\nend",
  php: '<?php\n$a = "x"; // c\necho strlen($a);',
  lua: '-- c\nlocal a = [[s]]\nfunction f() return nil end',
  powershell: '# c\n$x = Get-Item -Path "a"\nif ($true) { }',
};

describe('tokenize 无损', () => {
  for (const [lang, src] of Object.entries(SAMPLES)) {
    test(`${lang}: token 拼回逐字等于原文，按行切分后也一致`, () => {
      const ts = tokenize(src, lang as LangId);
      expect(join(ts)).toBe(src);
      const lines = splitLines(ts);
      expect(lines.map((l) => l.map((t) => t.text).join('')).join('\n')).toBe(src);
    });
  }

  test('未闭合的块注释/字符串不死循环、仍无损', () => {
    for (const lang of ['js', 'python', 'sql', 'xml', 'toml'] as LangId[]) {
      for (const src of ['/* open', '"open', "'open", '<a href="x', '"""open', '$$ open', '<!-- open']) {
        expect(join(tokenize(src, lang))).toBe(src);
      }
    }
  });
});

describe('各语言关键 token', () => {
  test('Python：装饰器、关键字、三引号跨行字符串、注释、字面量', () => {
    const ts = tokenize(SAMPLES.python, 'python');
    expect(of(ts, 'meta')).toContain('@dataclass');
    expect(of(ts, 'keyword')).toEqual(expect.arrayContaining(['def', 'return']));
    expect(of(ts, 'string')).toContain('"""doc\n    more"""');
    expect(of(ts, 'comment')).toEqual(['# c']);
    expect(of(ts, 'literal')).toContain('None');
    expect(of(ts, 'fn')).toContain('f');
  });

  test('Go：原始字符串、内置、nil', () => {
    const ts = tokenize(SAMPLES.go, 'go');
    expect(of(ts, 'string')).toContain('`raw\nline`');
    expect(of(ts, 'builtin')).toContain('len');
    expect(of(ts, 'literal')).toContain('nil');
    expect(of(ts, 'keyword')).toEqual(expect.arrayContaining(['package', 'func']));
  });

  test('Bash：变量、注释只认词首 #（$# 不是注释）、选项', () => {
    const ts = tokenize(SAMPLES.bash, 'bash');
    expect(of(ts, 'comment')).toEqual(['#!/bin/bash', '# comment']);
    expect(of(ts, 'variable')).toContain('$#');
    // 双引号内展开的变量单独标出；单引号串不展开
    expect(of(ts, 'variable')).toEqual(expect.arrayContaining(['$HOME', '${USER}']));
    expect(of(ts, 'string')).toEqual(expect.arrayContaining(['"', ' ', "'lit'"]));
    expect(of(tokenize('echo "a \\$HOME $X"', 'bash'), 'variable')).toEqual(['$X']);
    expect(of(ts, 'attr')).toContain('--flag');
    expect(of(ts, 'keyword')).toEqual(expect.arrayContaining(['if', 'then', 'fi']));
  });

  test('BAT：REM / :: 注释大小写不敏感、标签、%变量%', () => {
    const ts = tokenize(SAMPLES.bat, 'bat');
    expect(of(ts, 'comment')).toEqual(['REM hello', ':: note']);
    expect(of(ts, 'meta')).toContain(':start');
    expect(of(ts, 'variable')).toContain('%PATH%');
    expect(of(ts, 'keyword')).toEqual(expect.arrayContaining(['echo', 'off', 'set', 'if', 'exist', 'goto']));
  });

  test("SQL：关键字大小写不敏感、'' 转义、$$ 函数体、psql 元命令、引号标识符、参数", () => {
    const ts = tokenize(SAMPLES.sql, 'sql');
    expect(of(ts, 'meta')).toEqual(['\\set ON_ERROR_STOP on']);
    expect(of(ts, 'comment')).toEqual(['-- c']);
    expect(of(ts, 'keyword')).toEqual(expect.arrayContaining(['SELECT', 'FROM', 'WHERE', 'CREATE', 'FUNCTION']));
    expect(of(ts, 'string')).toEqual(expect.arrayContaining(["'it''s'", '$$ select 1 $$']));
    expect(of(ts, 'attr')).toContain('"Name"');
    expect(of(ts, 'variable')).toContain('$1');
  });

  test('YAML：缩进键与列表项键、注释、文档分隔、锚点', () => {
    const ts = tokenize(SAMPLES.yaml, 'yaml');
    expect(of(ts, 'key')).toEqual(['name', 'jobs', 'build', 'run', 'if', 'other']);
    expect(of(ts, 'variable')).toContain('&a');
    expect(of(ts, 'comment')).toEqual(['# c']);
    expect(of(ts, 'meta')).toContain('---');
    expect(of(ts, 'literal')).toContain('true');
  });

  test('INI / properties / .env：节、键（含缩进与 export）、注释', () => {
    const ts = tokenize(SAMPLES.ini, 'ini');
    expect(of(ts, 'meta')).toEqual(['[section]']);
    expect(of(ts, 'key')).toEqual(['key', 'indented.key', 'TOKEN']);
    expect(of(ts, 'comment')).toEqual(['; c']);
    const props = tokenize('# c\n! also\napp.name=demo\nserver.port: 8080', 'ini');
    expect(of(props, 'comment')).toEqual(['# c', '! also']);
    expect(of(props, 'key')).toEqual(['app.name', 'server.port']);
  });

  test('JSON：键与值区分', () => {
    const ts = tokenize(SAMPLES.json, 'json');
    expect(of(ts, 'key')).toEqual(['"name"', '"n"', '"ok"', '"z"']);
    expect(of(ts, 'string')).toEqual(['"panda"']);
    expect(of(ts, 'literal')).toEqual(['true', 'null']);
  });

  test('TOML：表头、缩进键、日期', () => {
    const ts = tokenize(SAMPLES.toml, 'toml');
    expect(of(ts, 'meta')).toEqual(['[tool.x]', '[[bin]]']);
    expect(of(ts, 'key')).toEqual(['name', 'ver', 'date']);
    expect(of(ts, 'number')).toContain('2026-09-23');
  });

  test('Java / Gradle：注解、类型、十六进制', () => {
    const ts = tokenize(SAMPLES.java, 'java');
    expect(of(ts, 'meta')).toEqual(['@Override']);
    expect(of(ts, 'type')).toEqual(expect.arrayContaining(['void', 'String', 'int']));
    expect(of(ts, 'number')).toContain('0x1F');
    const g = tokenize("plugins { id 'java' }\ndependencies { implementation(\"a:b:1\") }", 'java');
    expect(of(g, 'string')).toEqual(["'java'", '"a:b:1"']);
    expect(of(g, 'fn')).toContain('implementation');
  });

  test('C：缩进的预处理指令', () => {
    expect(of(tokenize(SAMPLES.c, 'c'), 'meta')).toEqual(['#include', '#define']);
  });

  test('Dockerfile：行首指令（含缩进）与 AS、变量、选项', () => {
    const ts = tokenize(SAMPLES.dockerfile, 'dockerfile');
    expect(of(ts, 'keyword')).toEqual(['FROM', 'AS', 'RUN', 'ENV']);
    expect(of(ts, 'variable')).toContain('$B');
    expect(of(ts, 'attr')).toContain('--omit');
  });

  test('CSS：属性键不误伤伪类选择器', () => {
    const ts = tokenize(SAMPLES.css, 'css');
    expect(of(ts, 'key')).toEqual(['color', 'margin']);
    expect(of(ts, 'variable')).toContain('--x');
    expect(of(ts, 'meta')).toContain(':hover');
    expect(of(ts, 'keyword')).toContain('@media');
  });

  test('XML：标签名、属性名、属性值、注释、实体', () => {
    const ts = tokenize(SAMPLES.xml, 'xml');
    expect(of(ts, 'tag')).toEqual(['a', 'b', 'a']);
    expect(of(ts, 'attr')).toEqual(['href', 'data-y']);
    expect(of(ts, 'string')).toEqual(['"x"', "'1'"]);
    expect(of(ts, 'comment')).toEqual(['<!-- c -->']);
    expect(of(ts, 'variable')).toEqual(['&amp;']);
  });

  test('diff：增删行', () => {
    const ts = tokenize(SAMPLES.diff, 'diff');
    expect(of(ts, 'deleted')).toEqual(['-old']);
    expect(of(ts, 'inserted')).toEqual(['+new']);
  });
});

describe('安全：分词只产出文本，渲染不拼 HTML', () => {
  test('HTML 源码里的脚本与事件属性只是 token 文本', () => {
    const src = '<img src=x onerror="alert(1)"><script>document.cookie</script>';
    const ts = tokenize(src, 'xml');
    expect(join(ts)).toBe(src);
    for (const t of ts) expect(typeof t.text).toBe('string');
    expect(of(ts, 'attr')).toContain('onerror');
  });

  test('CodeView 以文本子节点渲染 token，不使用 innerHTML', () => {
    const view = readFileSync(new URL('../components/CodeView.tsx', import.meta.url), 'utf8').replace(/\/\*\*[\s\S]*?\*\//, '');
    expect(view).not.toContain('dangerouslySetInnerHTML');
    expect(view).not.toContain('innerHTML');
    expect(view).toContain('{tok.text}');
  });
});

describe('性能边界', () => {
  test('超过字符数/行数上限不高亮，并标记 limited', () => {
    expect(withinHighlightLimit('a\n'.repeat(MAX_HIGHLIGHT_LINES - 1))).toBe(true);
    expect(withinHighlightLimit('\n'.repeat(MAX_HIGHLIGHT_LINES))).toBe(false);
    expect(withinHighlightLimit('x'.repeat(MAX_HIGHLIGHT_CHARS + 1))).toBe(false);
    const big = codeLines('let a = 1;\n'.repeat(MAX_HIGHLIGHT_LINES + 5), 'js');
    expect(big.highlighted).toBe(false);
    expect(big.limited).toBe(true);
    expect(big.lines.length).toBe(MAX_HIGHLIGHT_LINES + 6);
    // 无语言的纯文本不算「被限制」
    expect(codeLines('x'.repeat(MAX_HIGHLIGHT_CHARS + 1), null).limited).toBe(false);
  });

  test('CRLF 统一成 LF 再分行', () => {
    const r = codeLines('a = 1\r\nb = 2\r\n', 'python');
    expect(r.highlighted).toBe(true);
    expect(r.lines.length).toBe(3);
  });

  test('上限附近的真实代码分词在合理时间内完成', () => {
    const unit = SAMPLES.js + '\n' + SAMPLES.python + '\n';
    const src = unit.repeat(Math.floor(MAX_HIGHLIGHT_CHARS / unit.length));
    for (const lang of ['js', 'python', 'sql', 'yaml', 'xml'] as LangId[]) {
      const t0 = performance.now();
      const ts = tokenize(src, lang);
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(ts.length).toBeGreaterThan(0);
    }
  });
});

describe('路径识别：langOfPath + previewKind', () => {
  const cases: [string, LangId][] = [
    ['a/b.py', 'python'], ['main.go', 'go'], ['run.sh', 'bash'], ['x.bash', 'bash'], ['pom.xml', 'xml'],
    ['ci.yaml', 'yaml'], ['ci.yml', 'yaml'], ['setup.ini', 'ini'], ['package.json', 'json'], ['build.bat', 'bat'],
    ['build.cmd', 'bat'], ['App.java', 'java'], ['build.gradle', 'java'], ['build.gradle.kts', 'java'],
    ['application.properties', 'ini'], ['schema.sql', 'sql'], ['q.psql', 'sql'], ['q.pgsql', 'sql'],
    ['q.mysql', 'sql'], ['q.sqlite', 'sql'], ['ui/a.ts', 'js'], ['b.tsx', 'js'], ['c.mjs', 'js'], ['s.css', 'css'],
    ['s.scss', 'css'], ['Cargo.toml', 'toml'], ['Dockerfile', 'dockerfile'], ['Dockerfile.dev', 'dockerfile'],
    ['Makefile', 'makefile'], ['.env', 'ini'], ['.env.local', 'ini'], ['.gitignore', 'bash'], ['x.ps1', 'powershell'],
    ['index.html', 'xml'], ['fix.patch', 'diff'],
  ];
  for (const [p, lang] of cases) {
    test(`${p} → ${lang}`, () => expect(langOfPath(p)).toBe(lang));
  }

  test('代码/配置文件都判为 text（不再落到下载），HTML/图片/PDF 分支不变', () => {
    for (const [p] of cases) {
      if (p.endsWith('.html')) continue;
      expect(previewKind(p)).toBe('text');
    }
    expect(previewKind('index.html')).toBe('html');
    expect(previewKind('logo.svg')).toBe('image');
    expect(previewKind('doc.pdf')).toBe('pdf');
    expect(previewKind('archive.zip')).toBe('download');
    expect(previewKind('README.md')).toBe('text');
    expect(langOfPath('README.md')).toBeNull();
    expect(langOfPath('notes.txt')).toBeNull();
  });
});
