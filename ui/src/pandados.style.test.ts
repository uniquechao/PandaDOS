import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
const login = readFileSync(new URL('./views/Login.tsx', import.meta.url), 'utf8');
const provider = readFileSync(new URL('./i18n/provider.tsx', import.meta.url), 'utf8');
const enCatalog = readFileSync(new URL('../../shared/i18n/catalogs/en.ts', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('PandaDOS 品牌视觉系统', () => {
  test('可见品牌只保留 PandaDOS 名称与标识，不展示内部定位口号', () => {
    const visible = `${index}\n${main}\n${login}`;
    expect(visible).toContain('PandaDOS');
    expect(visible).not.toContain('Developer Orchestration System for AI Agents');
    expect(login).not.toContain("t('login.tagline')");
    expect(login).not.toContain('class="login-sub"');
    expect(index).toContain('<title>PandaDOS</title>');
    expect(index).not.toContain('meta name="description"');
    expect(provider).not.toContain("t('document.title')");
    expect(provider).not.toContain("t('document.description')");
    expect(enCatalog).not.toContain("'login.tagline'");
    expect(enCatalog).not.toContain("'document.title'");
    expect(enCatalog).not.toContain("'document.description'");
    expect(login).not.toContain('让协作，自成系统。');
    expect(visible).not.toMatch(/MandoAI|曼拓/);
  });

  test('标签页标题跟随当前项目：项目内「项目名-PandaDOS」，项目外回落品牌名', () => {
    const docTitle = readFileSync(new URL('./lib/docTitle.ts', import.meta.url), 'utf8');
    expect(main).toContain("import { useDocumentTitle } from './lib/docTitle'");
    expect(main).toContain('useDocumentTitle(curPid)');
    expect(docTitle).toContain("export const BRAND_TITLE = 'PandaDOS'");
    expect(docTitle).toContain('${name}-${BRAND_TITLE}');
  });

  test('侧栏品牌锁定在展开、折叠和移动端保持清晰比例', () => {
    expect(main).toContain('<button type="button" class="brand-home" title="PandaDOS"');
    expect(main).toContain("import releaseInfo from '../../release.json'");
    expect(main).toContain('class="brand-version"');
    expect(main).toContain('setReleaseOpen(true)');
    expect(main).toContain('<ReleaseNotes');
    expect(main).not.toContain('BRAND_SLOGAN');
    expect(main).not.toContain('brand-slogan');
    expect(css).toMatch(/\.brand-version\s*\{[^}]*font-size:\s*11px[^}]*color:\s*var\(--mut\)/s);
    expect(css).toMatch(/\.brand-logo\s*\{[^}]*width:\s*56px;\s*height:\s*56px/s);
    expect(css).toMatch(/\.sidebar\.collapsed \.brand-logo\s*\{[^}]*width:\s*46px;\s*height:\s*46px/s);
    expect(css).toMatch(/@media \(max-width: 719px\)[\s\S]*?\.brand-logo\s*\{[^}]*width:\s*40px;\s*height:\s*40px/s);
    expect(css).toMatch(/@media \(max-width: 719px\)[\s\S]*?\.brand-copy\s*\{\s*display:\s*none/s);
  });

  test('颜色、圆角、阴影与动效 Token 对齐参考图', () => {
    expect(css).toContain('--accent: #ffb629');
    expect(css).toContain('--cream: #fff6ef');
    expect(css).toContain('--line: #e7e2db');
    expect(css).toContain('--fg: #1f1f1f');
    expect(css).toContain('--motion-instant: 80ms');
    expect(css).toContain('--motion-fast: 140ms');
    expect(css).toContain('--motion-base: 220ms');
    expect(css).toContain('--motion-slow: 320ms');
    expect(css).toContain('--motion-panel: 420ms');
    expect(css).toContain('--ease-emphasized: cubic-bezier(0.2, 0.8, 0.2, 1)');
  });

  test('交互状态覆盖 hover、press、disabled、loading、success、骨架与弹层', () => {
    expect(css).toMatch(/\.btn:hover:not\(:disabled\)[^}]*translateY\(-1px\)/s);
    expect(css).toMatch(/\.btn:active:not\(:disabled\)[^}]*scale\(0\.98\)/s);
    expect(css).toMatch(/\.btn:disabled[^}]*opacity:\s*0\.45[^}]*not-allowed/s);
    expect(css).toMatch(/\.spinner[^}]*spin\s+0\.9s\s+linear\s+infinite/s);
    expect(css).toContain('@keyframes success-pop');
    expect(css).toMatch(/\.skel::after[^}]*shimmer\s+1\.6s/s);
    expect(css).toMatch(/\.modal[^}]*var\(--motion-panel\)/s);
  });

  test('终端、触屏与 reduced-motion 有独立规则', () => {
    expect(css).toMatch(/\.termbox[^}]*#1f1f1f/s);
    expect(css).toContain('@media (pointer: coarse)');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration:\s*0\.001ms/);
  });
});

describe('PandaDOS 品牌位图', () => {
  const sizes = [
    ['logo-mark.png', 256],
    ['favicon.png', 64],
    ['apple-touch-icon.png', 180],
  ] as const;

  test.each(sizes)('%s 在 ui/public 与 public 同步且尺寸正确', (name, size) => {
    const uiAsset = readFileSync(new URL(`../public/${name}`, import.meta.url));
    const builtAsset = readFileSync(new URL(`../../public/${name}`, import.meta.url));
    expect(uiAsset.equals(builtAsset)).toBe(true);
    expect(uiAsset.subarray(1, 4).toString()).toBe('PNG');
    expect(uiAsset.readUInt32BE(16)).toBe(size);
    expect(uiAsset.readUInt32BE(20)).toBe(size);
  });
});
