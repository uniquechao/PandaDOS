/**
 * core/uploads 单测 —— v1 src/uploads.test.ts 纯函数全套平移 +
 * v2 新增：Driver 化的 addGitExclude（常规仓库/worktree/非 git）与 saveUploadImage 落盘。
 */
import { afterAll, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalDriver } from '../executor/local';
import {
  UPLOAD_DIR,
  absImages,
  addGitExclude,
  extractUploadRels,
  imageReadHint,
  isUploadRel,
  resolveGitExcludePath,
  safeImageName,
  saveUploadImage,
  stripImageHint,
  uploadId,
} from './uploads';

// ---------- 纯函数（v1 平移） ----------

test('safeImageName keeps a clean image filename', () => {
  expect(safeImageName('shot.png')).toBe('shot.png');
  expect(safeImageName('photo.JPEG')).toBe('photo.JPEG');
});
test('safeImageName strips path components (no traversal)', () => {
  expect(safeImageName('../../etc/passwd.png')).toBe('passwd.png');
  expect(safeImageName('a/b/c.jpg')).toBe('c.jpg');
  expect(safeImageName('C:\\x\\y.gif')).toBe('y.gif');
});
test('safeImageName sanitizes weird chars', () => {
  expect(safeImageName('my shot!@#.jpeg')).toBe('my_shot_.jpeg');
});
test('safeImageName rejects non-images and extensionless', () => {
  expect(safeImageName('evil.exe')).toBeNull();
  expect(safeImageName('noext')).toBeNull();
  expect(safeImageName('..png')).toBeNull(); // leading dots stripped → no extension left
  expect(safeImageName('')).toBeNull();
});

test('isUploadRel only accepts paths inside the upload dir', () => {
  expect(isUploadRel(UPLOAD_DIR + '/abc/x.png')).toBe(true);
  expect(isUploadRel('./' + UPLOAD_DIR + '/abc/x.png')).toBe(true);
  expect(isUploadRel('foo/x.png')).toBe(false);
  expect(isUploadRel(UPLOAD_DIR + '/../secret')).toBe(false);
  expect(isUploadRel('')).toBe(false);
});

test('uploadId is a non-empty url-safe id and varies', () => {
  const a = uploadId(),
    b = uploadId();
  expect(a).toMatch(/^[a-z0-9]+$/);
  expect(a.length).toBeGreaterThan(6);
  expect(a).not.toBe(b);
});

test('imageReadHint is empty without images, references Read + abs paths otherwise', () => {
  expect(imageReadHint([])).toBe('');
  const h = imageReadHint(['/proj/.tmux-butler-uploads/x/a.png', '/proj/b.png']);
  expect(h).toContain('Read');
  expect(h).toContain('/proj/.tmux-butler-uploads/x/a.png');
  expect(h).toContain('/proj/b.png');
  expect(h).toContain('2 张');
});

// ---------- imageReadHint 的逆运算：extractUploadRels / stripImageHint ----------

// 按 web/ws/chat.ts 的实际拼法造「注入回显的用户消息文本」：cleanHint = hint.replace(/^\n+/, '')，
// 带正文时 combined = cleanHint + '\n' + 正文；纯图时 combined = cleanHint。测逆函数对着真实生产形态。
const ABS = ['/proj/.tmux-butler-uploads/ab12cd/a.png', '/proj/.tmux-butler-uploads/ef34gh/b.jpg'];
const REL = ['.tmux-butler-uploads/ab12cd/a.png', '.tmux-butler-uploads/ef34gh/b.jpg'];
const CLEAN_HINT = imageReadHint(ABS).replace(/^\n+/, '');
const WITH_TEXT = CLEAN_HINT + '\n' + '看看这两张图';
const IMAGE_ONLY = CLEAN_HINT;
const COMPRESSED = WITH_TEXT.replace(/\n/g, ' '); // sendKeys 把换行压成空格的形态

test('extractUploadRels 从注入回显里抠出附图 rel（绝对路径切片还原、多图）', () => {
  expect(extractUploadRels(WITH_TEXT)).toEqual(REL);
  expect(extractUploadRels(IMAGE_ONLY)).toEqual(REL);
  expect(extractUploadRels(COMPRESSED)).toEqual(REL); // 换行被压成空格也能抓
});

test('extractUploadRels 无图返回 []（含空串/普通文本/非图片扩展名）', () => {
  expect(extractUploadRels('')).toEqual([]);
  expect(extractUploadRels('普通消息\n第二行')).toEqual([]);
  expect(extractUploadRels(UPLOAD_DIR + '/ab/notes.txt')).toEqual([]); // .txt 不在白名单
});

test('extractUploadRels 挡越界（..）、顺序去重、上限 6', () => {
  // 伪造越界引用：isUploadRel 复核挡下
  expect(extractUploadRels('· /x/' + UPLOAD_DIR + '/../secret.png 正文')).toEqual([]);
  // 同图重复只留一个
  expect(extractUploadRels(`· ${ABS[0]} · ${ABS[0]}`)).toEqual([REL[0]]);
  // 8 张不同图 → 截断到 6
  const many = Array.from({ length: 8 }, (_, i) => `/proj/${UPLOAD_DIR}/s${i}/p${i}.png`);
  const rels = extractUploadRels(many.map((p) => '· ' + p).join('\n'));
  expect(rels.length).toBe(6);
  expect(rels[0]).toBe(`${UPLOAD_DIR}/s0/p0.png`);
});

test('stripImageHint 剥掉 AI 向附图提示、只留用户正文（换行/空格两种形态）', () => {
  expect(stripImageHint(WITH_TEXT)).toBe('看看这两张图');
  expect(stripImageHint(COMPRESSED)).toBe('看看这两张图');
});

test('stripImageHint 纯图消息（无正文）→ 空串', () => {
  expect(stripImageHint(IMAGE_ONLY)).toBe('');
});

test('stripImageHint 无附图提示 → 原样返回（不动用户文本/空白）', () => {
  expect(stripImageHint('普通消息\n第二行')).toBe('普通消息\n第二行');
  expect(stripImageHint('')).toBe('');
});

test('absImages resolves relative against cwd, keeps absolute', () => {
  expect(absImages('/proj', ['a/b.png'])).toEqual(['/proj/a/b.png']);
  expect(absImages('/proj', ['/abs/c.png'])).toEqual(['/abs/c.png']);
  expect(absImages('/proj', undefined)).toEqual([]);
});

// ---------- 副作用（经 LocalDriver） ----------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'butler2-uploads-'));
afterAll(async () => {
  try {
    await fsp.rm(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});
const driver = new LocalDriver();
const LINE = UPLOAD_DIR + '/';

function excludeHits(text: string): number {
  return text.split('\n').filter((l) => l.trim() === LINE).length;
}

async function initRepo(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  const g = async (args: string[]) => {
    const r = await driver.git(dir, args);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err || r.out}`);
  };
  await g(['init']);
  await g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await g(['config', 'user.email', 't@t']);
  await g(['config', 'user.name', 't']);
  await fsp.writeFile(path.join(dir, 'README.md'), 'x\n');
  await g(['add', '.']);
  await g(['commit', '-m', 'init']);
}

test('addGitExclude appends once to .git/info/exclude (idempotent, v1 semantics)', async () => {
  const repo = path.join(TMP, 'repo');
  await fsp.mkdir(path.join(repo, '.git', 'info'), { recursive: true });
  await addGitExclude(driver, repo);
  await addGitExclude(driver, repo); // 第二次不应重复写
  const ex = await fsp.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
  expect(excludeHits(ex)).toBe(1);
});

test('addGitExclude is a no-op on non-git dirs', async () => {
  const plain = path.join(TMP, 'plain');
  await fsp.mkdir(plain, { recursive: true });
  await addGitExclude(driver, plain); // 不应抛
  expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);
});

test('addGitExclude creates info/exclude when .git exists but info/ does not', async () => {
  const repo = path.join(TMP, 'noinfo');
  await fsp.mkdir(path.join(repo, '.git'), { recursive: true }); // 只有 .git 目录
  await addGitExclude(driver, repo);
  const ex = await fsp.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
  expect(excludeHits(ex)).toBe(1);
});

test('addGitExclude preserves existing content and fixes missing trailing newline', async () => {
  const repo = path.join(TMP, 'existing');
  await fsp.mkdir(path.join(repo, '.git', 'info'), { recursive: true });
  const f = path.join(repo, '.git', 'info', 'exclude');
  await fsp.writeFile(f, '*.log'); // 无尾换行
  await addGitExclude(driver, repo);
  const ex = await fsp.readFile(f, 'utf-8');
  expect(ex).toBe('*.log\n' + LINE + '\n');
});

test('addGitExclude on a linked worktree writes the shared main-repo exclude (v2 改造点)', async () => {
  const repo = path.join(TMP, 'wtrepo');
  await initRepo(repo);
  const wt = path.join(TMP, 'wt1');
  const r = await driver.git(repo, ['worktree', 'add', wt, '-b', 'wtb']);
  expect(r.code).toBe(0);

  // .git 是文件 → 沿 gitdir/commondir 解析到主仓 exclude
  // macOS 的 /var 是 /private/var 符号链接；git rev-parse 会返回规范化后的真实路径。
  const expectedExclude = await fsp.realpath(path.join(repo, '.git', 'info', 'exclude'));
  expect(await resolveGitExcludePath(driver, wt)).toBe(expectedExclude);

  await addGitExclude(driver, wt);
  await addGitExclude(driver, wt); // 幂等
  const ex = await fsp.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf-8');
  expect(excludeHits(ex)).toBe(1);

  // 真实生效：worktree 里放截图后 git status 不被污染
  await fsp.mkdir(path.join(wt, UPLOAD_DIR, 'abc'), { recursive: true });
  await fsp.writeFile(path.join(wt, UPLOAD_DIR, 'abc', 'a.png'), 'fake');
  const st = await driver.git(wt, ['status', '--porcelain']);
  expect(st.code).toBe(0);
  expect(st.out).not.toContain(UPLOAD_DIR);
});

test('saveUploadImage writes via Driver under cwd/UPLOAD_DIR/<sub>/ and excludes from git', async () => {
  const proj = path.join(TMP, 'proj');
  await initRepo(proj);
  const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const saved = await saveUploadImage(driver, proj + '/', 'shot.png', data); // 尾斜杠也可

  expect(saved.name).toBe('shot.png');
  expect(isUploadRel(saved.rel)).toBe(true);
  expect(saved.rel.startsWith(UPLOAD_DIR + '/')).toBe(true);
  expect(saved.abs).toBe(path.join(proj, saved.rel));
  expect(new Uint8Array(await fsp.readFile(saved.abs))).toEqual(data);

  // git exclude 顺手写好
  const ex = await fsp.readFile(path.join(proj, '.git', 'info', 'exclude'), 'utf-8');
  expect(excludeHits(ex)).toBe(1);

  // 同名再传 → 不同随机子目录，互不覆盖
  const saved2 = await saveUploadImage(driver, proj, 'shot.png', data);
  expect(saved2.rel).not.toBe(saved.rel);
  expect(fs.existsSync(saved.abs)).toBe(true);
  expect(fs.existsSync(saved2.abs)).toBe(true);
});

test('saveUploadImage rejects non-whitelisted names', async () => {
  const proj = path.join(TMP, 'proj2');
  await fsp.mkdir(proj, { recursive: true });
  await expect(saveUploadImage(driver, proj, 'evil.exe', new Uint8Array([1]))).rejects.toThrow();
});
