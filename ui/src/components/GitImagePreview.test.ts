import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { gitImageUrls } from './GitImagePreview';

const component = readFileSync(new URL('./GitImagePreview.tsx', import.meta.url), 'utf8');
const gitView = readFileSync(new URL('../views/Git.tsx', import.meta.url), 'utf8');
const issueView = readFileSync(new URL('../views/IssueDetail.tsx', import.meta.url), 'utf8');
const style = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('GitImagePreview', () => {
  test('按 Git 状态生成正确的新旧侧 URL，并保留重命名前路径', () => {
    const endpoint = '/api/projects/1/git/commits/abc/raw';
    expect(gitImageUrls(endpoint, 'new.png', undefined, 'A')).toEqual({
      new: `${endpoint}?path=new.png&side=new`,
    });
    expect(gitImageUrls(endpoint, 'new.png', undefined, '?')).toEqual({
      new: `${endpoint}?path=new.png&side=new`,
    });
    expect(gitImageUrls(endpoint, 'gone.png', undefined, 'D')).toEqual({
      old: `${endpoint}?path=gone.png&side=old`,
    });
    expect(gitImageUrls(endpoint, 'new name.png', 'old name.png', 'R100')).toEqual({
      new: `${endpoint}?path=new+name.png&side=new&old=old+name.png`,
      old: `${endpoint}?path=new+name.png&side=old&old=old+name.png`,
    });
  });

  test('具备加载、失败、下载、键盘名称和原图灯箱契约', () => {
    expect(component).toContain("t('ui.loading')");
    expect(component).toContain("t('ui.imageLoadFailed')");
    expect(component).toContain("t('git.openImage', { name })");
    expect(component).toContain("t('git.downloadImage', { name })");
    expect(component).toContain('<ImageLightbox');
    expect(component).toContain('download={name}');
    expect(component).toContain('role="status"');
  });

  test('项目 Git 与 issue 的宽窄屏入口共用图片内容分派和三类 raw 端点', () => {
    expect(gitView).toContain('export function DiffContent');
    expect(gitView).toContain('<GitImagePreview');
    expect(gitView).toContain('/git/worktree/raw');
    expect(gitView).toContain('/git/commits/${sha}/raw');
    expect(issueView).toContain('<DiffContent');
    expect(issueView).toContain('/issues/${iid}/git/raw');
    expect(issueView).toContain('/git/worktree/raw');
  });

  test('双栏预览在窄屏改为纵向，并保留可见焦点与触控高度', () => {
    expect(style).toContain('.git-img-preview');
    expect(style).toContain('.git-img-open:focus-visible');
    expect(style).toContain('min-height: 44px');
    expect(style).toContain('.git-img-download { margin-left: auto; width: 40px; height: 40px;');
    expect(style).toContain('@media (max-width: 700px)');
    expect(style).toContain('.git-img-preview { flex-direction: column;');
  });
});
