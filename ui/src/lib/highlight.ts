/**
 * 轻量语法高亮（工作区 FileViewer 只读代码视图用，issue #388）。
 *
 * 只做「分词 → token 列表」，不产出 HTML 字符串：渲染方把每个 token 当文本子节点交给 preact，
 * 文件内容天然被转义，文件里的 `<script>` 等只会显示成字面文本。分词无损——所有 token 的 text
 * 按序拼回必须逐字等于原文（单测守着）。
 *
 * 引擎：每种语言是一组有序规则（带 y 粘连标志的正则），在当前位置逐条尝试，先中先得；
 * 规则可用 groups 把捕获组拆成多个 token（如 `key` + `:`），或用 sub 对整段再细分（如 XML 标签内属性）。
 * 标识符统一走一条规则，再按关键字/字面量/类型/内置表分类，后随 `(` 的记为函数名。
 * 性能边界：超过 MAX_HIGHLIGHT_CHARS 或 MAX_HIGHLIGHT_LINES 不分词（调用方回落纯文本显示）。
 */

export type TokenType =
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'literal'
  | 'type'
  | 'builtin'
  | 'fn'
  | 'key'
  | 'tag'
  | 'attr'
  | 'variable'
  | 'meta'
  | 'punct'
  | 'inserted'
  | 'deleted';

/** type 为空串 = 普通文本 */
export interface Token {
  type: TokenType | '';
  text: string;
}

export const MAX_HIGHLIGHT_CHARS = 256 * 1024;
export const MAX_HIGHLIGHT_LINES = 10000;

interface Rule {
  re: RegExp;
  type?: TokenType;
  /** 捕获组 → token 类型（'' 为普通文本）；各组拼起来须等于整段匹配 */
  groups?: (TokenType | '')[];
  sub?: (text: string) => Token[];
}

interface Lang {
  rules: Rule[];
  keywords?: Set<string>;
  literals?: Set<string>;
  types?: Set<string>;
  builtins?: Set<string>;
  /** 关键字大小写不敏感（SQL / BAT / Dockerfile） */
  ci?: boolean;
  /** 标识符正则（默认 [A-Za-z_$][\w$]*） */
  ident?: RegExp;
  /** 标识符后紧跟 `(` 记为函数名 */
  calls?: boolean;
}

const words = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));
const y = (src: string, flags = ''): RegExp => new RegExp(src, 'y' + flags);

// ---- 通用片段 ----
const SLASH_LINE = { re: y('//.*'), type: 'comment' } as const;
const SLASH_BLOCK = { re: y('/\\*[\\s\\S]*?(?:\\*/|$)'), type: 'comment' } as const;
const HASH_LINE = { re: y('#.*'), type: 'comment' } as const;
const DQ = { re: y('"(?:[^"\\\\\\n]|\\\\.)*"?'), type: 'string' } as const;
const SQ = { re: y("'(?:[^'\\\\\\n]|\\\\.)*'?"), type: 'string' } as const;
const NUM = {
  re: y('(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\\d[\\d_]*(?:\\.\\d[\\d_]*)?|\\.\\d[\\d_]*)(?:[eE][+-]?\\d+)?)[a-zA-Z]*'),
  type: 'number',
} as const;
const WS = { re: y('\\s+') } as const;
const OPS = { re: y('[{}()\\[\\];,.:]'), type: 'punct' } as const;

const clike = (extra: Rule[] = []): Rule[] => [WS, SLASH_LINE, SLASH_BLOCK, ...extra, DQ, SQ, NUM, OPS];

// ---- 各语言 ----
const JS_KW = words(`
  break case catch class const continue debugger default delete do else export extends finally for from function
  if import in instanceof let new of return static super switch this throw try typeof var void while with yield
  async await as get set implements interface package private protected public enum type namespace declare
  abstract readonly keyof satisfies infer is override module require`);
const JS_LIT = words('true false null undefined NaN Infinity');
const JS_TYPES = words('string number boolean any unknown never object symbol bigint void Array Promise Record Map Set Date Error RegExp');
const JS: Lang = {
  rules: [
    WS, SLASH_LINE, SLASH_BLOCK,
    { re: y('`(?:[^`\\\\]|\\\\[\\s\\S])*`?'), type: 'string' },
    DQ, SQ, NUM,
    { re: y('@[A-Za-z_][\\w.]*'), type: 'meta' },
    OPS,
  ],
  keywords: JS_KW, literals: JS_LIT, types: JS_TYPES,
  builtins: words('console window document globalThis process Math JSON Object String Number Boolean Symbol'),
  calls: true,
};

const JSON_LANG: Lang = {
  rules: [
    WS, SLASH_LINE, SLASH_BLOCK,
    { re: y('"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)'), type: 'key' },
    DQ, NUM, OPS,
  ],
  literals: words('true false null'),
};

const PY_KW = words(`
  and as assert async await break class continue def del elif else except finally for from global if import in is
  lambda nonlocal not or pass raise return try while with yield match case`);
const PY: Lang = {
  rules: [
    WS, HASH_LINE,
    { re: y('[rRbBuUfF]{0,2}(?:"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$))'), type: 'string' },
    { re: y('[rRbBuUfF]{1,2}(?=["\'])') , type: 'string' },
    DQ, SQ, NUM,
    { re: y('@[A-Za-z_][\\w.]*'), type: 'meta' },
    OPS,
  ],
  keywords: PY_KW,
  literals: words('True False None'),
  builtins: words('self cls print len range int str float bool list dict set tuple open isinstance super type object Exception'),
  calls: true,
};

const GO: Lang = {
  rules: clike([{ re: y('`[^`]*`?'), type: 'string' }]),
  keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map
    package range return select struct switch type var`),
  literals: words('true false nil iota'),
  types: words(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8
    uint16 uint32 uint64 uintptr any`),
  builtins: words('append cap close copy delete len make new panic print println recover'),
  calls: true,
};

const JAVA_KW = words(`
  abstract assert break case catch class const continue default do else enum extends final finally for goto if
  implements import instanceof interface native new package private protected public return static strictfp super
  switch synchronized this throw throws transient try volatile while var record sealed permits yield
  fun val when object companion data inner open override lateinit init internal suspend inline typealias by is in out
  def as trait`);
const JAVA: Lang = {
  rules: clike([
    { re: y('"""[\\s\\S]*?(?:"""|$)'), type: 'string' },
    { re: y('@[A-Za-z_][\\w.]*'), type: 'meta' },
  ]),
  keywords: JAVA_KW,
  literals: words('true false null'),
  types: words('boolean byte char double float int long short void String Object Integer Long Double List Map Set Unit Any'),
  calls: true,
};

const C_LANG: Lang = {
  rules: [
    WS,
    { re: y('(?<=^[ \\t]*)#[ \\t]*\\w+', 'm'), type: 'meta' },
    SLASH_LINE, SLASH_BLOCK, DQ, SQ, NUM, OPS,
  ],
  keywords: words(`auto break case char const continue default do double else enum extern float for goto if inline int long
    register return short signed sizeof static struct switch typedef union unsigned void volatile while
    class namespace template typename public private protected virtual override new delete this throw try catch using
    constexpr nullptr_t noexcept operator friend explicit mutable
    fn let mut impl trait pub use mod crate self Self match loop move ref where dyn unsafe async await as in
    func var guard defer extension protocol struct init deinit`),
  literals: words('true false NULL nullptr null nil None Some Ok Err'),
  types: words('int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t size_t bool i32 i64 u8 u32 u64 usize f32 f64 str String Vec Option Result'),
  calls: true,
};

const SH_VAR = '\\$\\{[^}\\n]*\\}?|\\$\\(\\(?|\\$[A-Za-z_]\\w*|\\$[0-9@#?$!*-]';
/** Shell 双引号串：内部 $VAR / ${…} 单独标成变量（单引号串不展开，不拆） */
function shDouble(text: string): Token[] {
  const out: Token[] = [];
  const re = new RegExp(SH_VAR, 'g');
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > 0 && text[m.index - 1] === '\\') continue; // \$ 转义
    if (m.index > last) out.push({ type: 'string', text: text.slice(last, m.index) });
    out.push({ type: 'variable', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: 'string', text: text.slice(last) });
  return out;
}
const SH_KW = words(`if then else elif fi for do done case esac while until function in select return local export
  readonly declare typeset unset shift break continue exit source alias set trap eval exec time`);
const SH: Lang = {
  rules: [
    WS,
    { re: y('(?:^|(?<=[\\s;|&(]))#.*', 'm'), type: 'comment' },
    { re: y("'[^']*'?"), type: 'string' },
    { re: y('"(?:[^"\\\\]|\\\\[\\s\\S])*"?'), sub: shDouble },
    { re: y(SH_VAR), type: 'variable' },
    { re: y('\\b\\d+\\b'), type: 'number' },
    { re: y('(?<![\\w-])--?[A-Za-z][\\w-]*'), type: 'attr' },
    { re: y('[;|&()<>{}\\[\\]]'), type: 'punct' },
  ],
  keywords: SH_KW,
  literals: words('true false'),
  builtins: words('echo printf cd pwd test read mkdir rm cp mv cat grep sed awk find xargs chmod chown curl wget git sudo tar ls kill sleep env'),
  ident: y('[A-Za-z_][\\w.-]*'),
};

const BAT: Lang = {
  rules: [
    WS,
    { re: y('(?<=^[ \\t]*)@?(?:rem(?:[ \\t].*)?$|::.*)', 'im'), type: 'comment' },
    { re: y('(?<=^[ \\t]*):[A-Za-z_][\\w.-]*', 'm'), type: 'meta' },
    { re: y('"[^"\\n]*"?'), type: 'string' },
    { re: y('%%~?[A-Za-z]|%~[a-zA-Z]*\\d|%[\\w#$@~:,=-]+%|%\\d|![\\w#$@~:,=-]+!'), type: 'variable' },
    { re: y('\\b\\d+\\b'), type: 'number' },
    { re: y('@'), type: 'punct' },
    { re: y('[()<>|&=]'), type: 'punct' },
  ],
  keywords: words(`if else for in do goto call set setlocal endlocal echo exit not exist defined errorlevel equ neq lss leq gtr geq
    shift pause start cd pushd popd title cls color choice enabledelayedexpansion enableextensions off on`),
  ci: true,
  ident: y('[A-Za-z_][\\w.-]*'),
};

const SQL: Lang = {
  rules: [
    WS,
    { re: y('(?<=^[ \\t]*)\\\\[A-Za-z!?].*', 'm'), type: 'meta' }, // psql 元命令 \d / \i …
    { re: y('--.*'), type: 'comment' },
    { re: y('(?:^|(?<=\\s))#(?![>#-]).*', 'm'), type: 'comment' }, // MySQL
    SLASH_BLOCK,
    { re: y('\\$([A-Za-z_]\\w*)?\\$[\\s\\S]*?(?:\\$\\1\\$|$)'), type: 'string' }, // PostgreSQL $$…$$
    { re: y("[eEnNxXbB]?'(?:[^']|'')*'?"), type: 'string' },
    { re: y('"(?:[^"]|"")*"?|`[^`]*`?'), type: 'attr' }, // 引号标识符
    { re: y('\\$\\d+|[:@][A-Za-z_]\\w*|\\?'), type: 'variable' },
    NUM, OPS,
  ],
  keywords: words(`select from where and or not insert into values update set delete create table view index drop alter add
    column primary key foreign references unique check default constraint join inner left right full outer cross on using
    group by order having limit offset union all distinct as case when then else end in is like ilike between exists
    begin commit rollback transaction returning with recursive grant revoke database schema if replace trigger function
    procedure returns language declare return cascade restrict asc desc nulls first last analyze explain vacuum pragma
    autoincrement auto_increment engine charset collate comment sequence extension materialized conflict do nothing
    partition over window lateral fetch next rows only temporary temp serial`),
  literals: words('true false null'),
  types: words(`int integer bigint smallint tinyint serial bigserial decimal numeric real double precision float char varchar
    text boolean bool date time timestamp timestamptz interval uuid json jsonb blob bytea`),
  ci: true,
  calls: true,
};

const YAML: Lang = {
  rules: [
    WS,
    { re: y('(?:^|(?<=\\s))#.*', 'm'), type: 'comment' },
    { re: y('^(?:---|\\.\\.\\.)(?=\\s|$)', 'm'), type: 'meta' },
    {
      re: y('(?<=^[ \\t]*)((?:-[ \\t]+)*)("(?:[^"\\\\\\n]|\\\\.)*"|\'[^\'\\n]*\'|[^\\s#\'"\\-{}\\[\\],][^:#\\n]*?|-[^\\s:#\\n][^:#\\n]*?)([ \\t]*:)(?=\\s|$)', 'm'),
      groups: ['punct', 'key', 'punct'],
    },
    DQ, SQ,
    { re: y('[&*][\\w-]+|![\\w!/-]*'), type: 'variable' },
    { re: y('[|>][+-]?(?=\\s*$)', 'm'), type: 'punct' },
    NUM,
    { re: y('[-{}\\[\\],:?]'), type: 'punct' },
  ],
  literals: words('true false yes no on off null True False Yes No On Off Null TRUE FALSE NULL ~'),
  ident: y('[A-Za-z_~][\\w.-]*'),
};

const INI: Lang = {
  rules: [
    WS,
    { re: y('(?<=^[ \\t]*)[;#!].*', 'm'), type: 'comment' },
    { re: y('(?<=^[ \\t]*)\\[[^\\]\\n]*\\]?', 'm'), type: 'meta' },
    { re: y('(?<=^[ \\t]*)((?:export[ \\t]+)?)([^=:\\s;#!\\[][^=:\\n]*?)([ \\t]*[=:])', 'm'), groups: ['keyword', 'key', 'punct'] },
    DQ, SQ,
    { re: y('\\$\\{[^}\\n]*\\}?|%\\([^)\\n]*\\)s|\\$[A-Za-z_]\\w*'), type: 'variable' },
    { re: y('(?<![\\w.])-?\\d+(?:\\.\\d+)?(?![\\w.])'), type: 'number' },
  ],
  literals: words('true false yes no on off null TRUE FALSE True False'),
  ident: y('[A-Za-z_][\\w.-]*'),
};

const TOML: Lang = {
  rules: [
    WS, HASH_LINE,
    { re: y('(?<=^[ \\t]*)\\[\\[?[^\\]\\n]*\\]?\\]?', 'm'), type: 'meta' },
    { re: y('(?<=^[ \\t]*)([A-Za-z0-9_.\\-"\'][A-Za-z0-9_.\\- "\']*?)([ \\t]*=)', 'm'), groups: ['key', 'punct'] },
    { re: y('"""[\\s\\S]*?(?:"""|$)|\'\'\'[\\s\\S]*?(?:\'\'\'|$)'), type: 'string' },
    DQ, { re: y("'[^'\\n]*'?"), type: 'string' },
    { re: y('\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})?)?'), type: 'number' },
    NUM, OPS,
    { re: y('='), type: 'punct' },
  ],
  literals: words('true false inf nan'),
};

const CSS: Lang = {
  rules: [
    WS, SLASH_BLOCK,
    { re: y('//.*'), type: 'comment' }, // scss/less
    DQ, SQ,
    { re: y('@[\\w-]+'), type: 'keyword' },
    { re: y('\\$[\\w-]+|--[\\w-]+'), type: 'variable' },
    { re: y('#[0-9a-fA-F]{3,8}(?![\\w-])'), type: 'number' },
    { re: y('-?(?:\\d+\\.?\\d*|\\.\\d+)(?:%|[a-zA-Z]+)?'), type: 'number' },
    { re: y('([A-Za-z-]+)(\\s*:)(?=[^;{}\\n]*[;}]|[^{\\n]*$)', 'm'), groups: ['key', 'punct'] },
    { re: y('[.#][A-Za-z_-][\\w-]*'), type: 'tag' },
    { re: y('::?[A-Za-z-]+'), type: 'meta' },
    { re: y('!important'), type: 'keyword' },
    { re: y('[{}()\\[\\];,:>+~*=]'), type: 'punct' },
  ],
  ident: y('[A-Za-z_][\\w-]*'),
  calls: true,
};

/** XML/HTML 标签内部：`<` `名字` 属性名 `=` 属性值 `>` */
function tagParts(text: string): Token[] {
  const out: Token[] = [];
  const m = /^(<\/?)([^\s/>]*)/.exec(text)!;
  out.push({ type: 'punct', text: m[1] }, { type: 'tag', text: m[2] });
  const re = /(\s+)|("[^"]*"?|'[^']*'?)|([^\s=>/"']+)|(\/?>|=|\/)/y;
  re.lastIndex = m[0].length;
  while (re.lastIndex < text.length) {
    const at = re.lastIndex;
    const r = re.exec(text);
    if (!r) {
      out.push({ type: '', text: text.slice(at) });
      break;
    }
    const type: Token['type'] = r[1] ? '' : r[2] ? 'string' : r[3] ? 'attr' : 'punct';
    out.push({ type, text: r[0] });
  }
  return out;
}

const XML: Lang = {
  rules: [
    WS,
    { re: y('<!--[\\s\\S]*?(?:-->|$)'), type: 'comment' },
    { re: y('<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)'), type: 'string' },
    { re: y('<\\?[\\s\\S]*?(?:\\?>|$)|<![A-Za-z][^>]*>?'), type: 'meta' },
    { re: y('</?[A-Za-z_][\\w:.-]*(?:\\s+[^\\s=>/"\']+(?:\\s*=\\s*(?:"[^"]*"?|\'[^\']*\'?|[^\\s>]+))?)*\\s*/?>?'), sub: tagParts },
    { re: y('&(?:#\\d+|#x[\\da-fA-F]+|\\w+);'), type: 'variable' },
    { re: y('[^<&\\s]+') },
  ],
};

const DOCKER: Lang = {
  rules: [
    WS,
    { re: y('(?<=^[ \\t]*)#.*', 'm'), type: 'comment' },
    {
      re: y('(?<=^[ \\t]*)(FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)(?=\\s)', 'im'),
      type: 'keyword',
    },
    { re: y('\\bAS\\b', 'i'), type: 'keyword' },
    DQ, SQ,
    { re: y('\\$\\{[^}\\n]*\\}?|\\$[A-Za-z_]\\w*'), type: 'variable' },
    { re: y('(?<![\\w-])--?[A-Za-z][\\w-]*'), type: 'attr' },
    { re: y('\\b\\d+\\b'), type: 'number' },
    { re: y('[\\[\\],=&|;\\\\]'), type: 'punct' },
  ],
  ident: y('[A-Za-z_][\\w.-]*'),
};

const MAKE: Lang = {
  rules: [
    WS, HASH_LINE,
    { re: y('^([A-Za-z0-9_.%/$(){} -]+?)(::?)(?!=)', 'm'), groups: ['fn', 'punct'] },
    { re: y('\\$\\([^)\\n]*\\)?|\\$\\{[^}\\n]*\\}?|\\$[@<^?*%+]'), type: 'variable' },
    DQ, SQ,
    { re: y('[:+?!]?='), type: 'punct' },
  ],
  keywords: words('ifeq ifneq ifdef ifndef else endif include define endef export override'),
  ident: y('[A-Za-z_][\\w.-]*'),
};

const DIFF: Lang = {
  rules: [
    { re: y('^(?:\\+\\+\\+|---) .*', 'm'), type: 'meta' },
    { re: y('^@@.*', 'm'), type: 'keyword' },
    { re: y('^\\+.*', 'm'), type: 'inserted' },
    { re: y('^-.*', 'm'), type: 'deleted' },
    { re: y('^(?:diff|index) .*', 'm'), type: 'comment' },
    { re: y('.+|\\n+') },
  ],
};

const RUBY: Lang = {
  rules: [WS, HASH_LINE, DQ, SQ, { re: y(':[A-Za-z_]\\w*[?!]?'), type: 'literal' }, { re: y('@@?[A-Za-z_]\\w*'), type: 'variable' }, NUM, OPS],
  keywords: words(`alias and begin break case class def defined do else elsif end ensure for if in module next not or redo
    rescue retry return self super then undef unless until when while yield require attr_accessor`),
  literals: words('true false nil'),
  calls: true,
};

const PHP: Lang = {
  rules: clike([HASH_LINE, { re: y('\\$[A-Za-z_]\\w*'), type: 'variable' }, { re: y('<\\?php|\\?>'), type: 'meta' }]),
  keywords: words(`abstract and as break case catch class const continue declare default do echo else elseif extends final
    finally fn for foreach function global if implements include interface namespace new or private protected public
    require return static switch throw trait try use var while yield match`),
  literals: words('true false null TRUE FALSE NULL'),
  calls: true,
};

const LUA: Lang = {
  rules: [WS, { re: y('--\\[\\[[\\s\\S]*?(?:\\]\\]|$)|--.*'), type: 'comment' }, { re: y('\\[\\[[\\s\\S]*?(?:\\]\\]|$)'), type: 'string' }, DQ, SQ, NUM, OPS],
  keywords: words('and break do else elseif end for function goto if in local not or repeat return then until while'),
  literals: words('true false nil'),
  calls: true,
};

const PS: Lang = {
  rules: [
    WS, { re: y('<#[\\s\\S]*?(?:#>|$)|#.*'), type: 'comment' }, DQ, SQ,
    { re: y('\\$[A-Za-z_][\\w:]*'), type: 'variable' },
    { re: y('(?<![\\w-])-[A-Za-z]+'), type: 'attr' }, NUM, OPS,
  ],
  keywords: words('begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while'),
  ci: true,
  ident: y('[A-Za-z_][\\w-]*'),
  literals: words('$true $false $null'),
};

export type LangId =
  | 'js' | 'json' | 'python' | 'go' | 'java' | 'c' | 'bash' | 'bat' | 'sql' | 'yaml' | 'ini' | 'toml' | 'css'
  | 'xml' | 'dockerfile' | 'makefile' | 'diff' | 'ruby' | 'php' | 'lua' | 'powershell';

const LANGS: Record<LangId, Lang> = {
  js: JS, json: JSON_LANG, python: PY, go: GO, java: JAVA, c: C_LANG, bash: SH, bat: BAT, sql: SQL, yaml: YAML,
  ini: INI, toml: TOML, css: CSS, xml: XML, dockerfile: DOCKER, makefile: MAKE, diff: DIFF, ruby: RUBY, php: PHP,
  lua: LUA, powershell: PS,
};

/** 扩展名 → 语言 */
const BY_EXT: Record<string, LangId> = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', vue: 'xml', svelte: 'xml',
  json: 'json', jsonc: 'json', json5: 'json', jsonl: 'json', ndjson: 'json', webmanifest: 'json', har: 'json', ipynb: 'json',
  py: 'python', pyw: 'python', pyi: 'python',
  go: 'go',
  java: 'java', kt: 'java', kts: 'java', gradle: 'java', groovy: 'java', scala: 'java', dart: 'java', cs: 'java',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', hxx: 'c', m: 'c', mm: 'c', rs: 'c', swift: 'c',
  proto: 'c', zig: 'c',
  sh: 'bash', bash: 'bash', zsh: 'bash', ksh: 'bash', fish: 'bash', command: 'bash',
  bat: 'bat', cmd: 'bat',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  sql: 'sql', psql: 'sql', pgsql: 'sql', mysql: 'sql', sqlite: 'sql', sqlite3: 'sql', plsql: 'sql', ddl: 'sql', dml: 'sql', hql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  ini: 'ini', cfg: 'ini', conf: 'ini', cnf: 'ini', properties: 'ini', prop: 'ini', env: 'ini', editorconfig: 'ini',
  gitconfig: 'ini', desktop: 'ini', service: 'ini', timer: 'ini', socket: 'ini', npmrc: 'ini', inf: 'ini', reg: 'ini',
  toml: 'toml',
  css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css',
  xml: 'xml', xsd: 'xml', xsl: 'xml', xslt: 'xml', plist: 'xml', pom: 'xml', csproj: 'xml', fsproj: 'xml', vbproj: 'xml',
  props: 'xml', targets: 'xml', resx: 'xml', xaml: 'xml', wsdl: 'xml', rss: 'xml', atom: 'xml', html: 'xml', htm: 'xml',
  xhtml: 'xml', svg: 'xml', jsp: 'xml', tld: 'xml', xib: 'xml', storyboard: 'xml', kml: 'xml', gpx: 'xml',
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  mk: 'makefile', mak: 'makefile',
  diff: 'diff', patch: 'diff',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby',
  php: 'php',
  lua: 'lua',
};

/** 无扩展名/点文件 → 语言（按文件名全称，小写） */
const BY_NAME: Record<string, LangId> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'makefile', gnumakefile: 'makefile',
  gemfile: 'ruby', rakefile: 'ruby', podfile: 'ruby', vagrantfile: 'ruby', brewfile: 'ruby',
  jenkinsfile: 'java', procfile: 'yaml',
  '.bashrc': 'bash', '.bash_profile': 'bash', '.bash_aliases': 'bash', '.bash_logout': 'bash', '.profile': 'bash',
  '.zshrc': 'bash', '.zprofile': 'bash', '.zshenv': 'bash', '.envrc': 'bash',
  '.env': 'ini', '.editorconfig': 'ini', '.gitconfig': 'ini', '.npmrc': 'ini', '.yarnrc': 'ini', '.pylintrc': 'ini',
  '.flake8': 'ini', '.gitattributes': 'ini', '.gitmodules': 'ini', 'setup.cfg': 'ini', 'tox.ini': 'ini',
  '.gitignore': 'bash', '.dockerignore': 'bash', '.npmignore': 'bash', '.prettierignore': 'bash', '.eslintignore': 'bash',
  '.babelrc': 'json', '.eslintrc': 'json', '.prettierrc': 'json', '.jshintrc': 'json',
  'go.mod': 'go', 'go.sum': 'go', 'cmakelists.txt': 'bash', 'requirements.txt': 'bash',
};

/** 文件路径 → 高亮语言；非代码类文本（txt/log/md/csv…）返回 null */
export function langOfPath(path: string): LangId | null {
  const base = (path.split('/').pop() ?? '').toLowerCase();
  if (!base) return null;
  if (BY_NAME[base]) return BY_NAME[base];
  // Dockerfile.dev / app.dockerfile / .env.local / docker-compose.override.yml 这类
  if (base.startsWith('dockerfile.') || base.startsWith('containerfile.')) return 'dockerfile';
  if (base.startsWith('.env.')) return 'ini';
  if (base.startsWith('makefile.')) return 'makefile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  return BY_EXT[base.slice(dot + 1)] ?? null;
}

/** 内容是否在高亮性能边界内 */
export function withinHighlightLimit(text: string): boolean {
  if (text.length > MAX_HIGHLIGHT_CHARS) return false;
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (++lines > MAX_HIGHLIGHT_LINES) return false;
  }
  return true;
}

const DEFAULT_IDENT = y('[A-Za-z_$][\\w$]*');

/** 全文分词（无损：token.text 拼回等于原文）。相邻普通文本会合并。 */
export function tokenize(text: string, lang: LangId): Token[] {
  const L = LANGS[lang];
  const out: Token[] = [];
  const push = (type: Token['type'], s: string): void => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.type === type && type === '') last.text += s;
    else out.push({ type, text: s });
  };
  const ident = L.ident ?? DEFAULT_IDENT;
  const n = text.length;
  let i = 0;
  outer: while (i < n) {
    for (const r of L.rules) {
      r.re.lastIndex = i;
      const m = r.re.exec(text);
      if (!m || m[0].length === 0) continue;
      if (r.groups) {
        r.groups.forEach((g, k) => push(g, m[k + 1] ?? ''));
      } else if (r.sub) {
        for (const t of r.sub(m[0])) push(t.type, t.text);
      } else {
        push(r.type ?? '', m[0]);
      }
      i += m[0].length;
      continue outer;
    }
    ident.lastIndex = i;
    const m = ident.exec(text);
    if (m && m[0].length > 0) {
      const w = m[0];
      const k = L.ci ? w.toLowerCase() : w;
      let type: Token['type'] = '';
      if (L.keywords?.has(k)) type = 'keyword';
      else if (L.literals?.has(k)) type = 'literal';
      else if (L.types?.has(k)) type = 'type';
      else if (L.builtins?.has(k)) type = 'builtin';
      else if (L.calls && text[i + w.length] === '(') type = 'fn';
      push(type, w);
      i += w.length;
      continue;
    }
    push('', text[i]);
    i++;
  }
  return out;
}

/** 把 token 流切成按行的 token 数组（跨行 token 拆开，保留类型；不含换行符本身） */
export function splitLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const t of tokens) {
    const parts = t.text.split('\n');
    parts.forEach((p, idx) => {
      if (idx > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ type: t.type, text: p });
    });
  }
  return lines;
}

/**
 * 代码视图的行数据：有语言且在性能边界内 → 高亮分行；否则按纯文本分行。
 * limited=true 表示因文件过大关闭了高亮（界面给提示）。
 */
export function codeLines(text: string, lang: LangId | null): { lines: Token[][]; highlighted: boolean; limited: boolean } {
  const src = text.replace(/\r\n?/g, '\n');
  if (lang && withinHighlightLimit(src)) {
    return { lines: splitLines(tokenize(src, lang)), highlighted: true, limited: false };
  }
  return {
    lines: src.split('\n').map((l) => (l ? [{ type: '', text: l }] : [])),
    highlighted: false,
    limited: lang !== null,
  };
}
