/**
 * 模块选择器（替换原生 input+datalist——原生样式无法定制，和整体设计不搭）：
 * 输入框 + 自定义下拉面板。面板列出 active 模块（显示名 + slug + 代理徽标），输入即
 * 过滤（匹配显示名/slug，不分大小写）；也允许自由输入建新模块（与后端 resolve 语义一致：
 * 英文名直接成 slug、中文名走分类器）。
 *
 * 值语义与旧 datalist 完全一致：value 是原始文本；点选选项 = 把 value 设为该模块 slug。
 * 父组件继续用 modules.find(slug/displayName 匹配) 判断是否命中现有模块（不改提交逻辑）。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ProjectModule } from '../lib/types';

/** 过滤（导出供测试）：空查询给全量；否则按显示名/slug 包含匹配（不分大小写） */
export function filterModules(modules: ProjectModule[], query: string): ProjectModule[] {
  const q = query.trim().toLowerCase();
  if (!q) return modules;
  return modules.filter(
    (m) => m.displayName.toLowerCase().includes(q) || m.slug.toLowerCase().includes(q),
  );
}

export function ModuleSelect({
  modules,
  value,
  onChange,
  placeholder,
}: {
  modules: ProjectModule[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const trimmed = value.trim();
  const filtered = filterModules(modules, value);
  const exact = modules.find((m) => m.slug === trimmed || m.displayName === trimmed);

  const pick = (v: string): void => {
    onChange(v);
    setOpen(false);
  };

  return (
    <div class="msel" ref={wrapRef}>
      <input
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onInput={(e) => {
          onChange(e.currentTarget.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && open) {
            e.preventDefault(); // 面板开着时回车是选择不是提交
            if (!exact && filtered[0]) pick(filtered[0].slug);
            else setOpen(false);
          }
        }}
      />
      <button
        type="button"
        class="msel-caret"
        tabIndex={-1}
        aria-label="展开模块列表"
        onClick={() => setOpen(!open)}
      >
        ▾
      </button>
      {open && (
        <div class="msel-panel">
          {trimmed !== '' && (
            <button type="button" class="msel-opt msel-clear" onClick={() => pick('')}>
              清空（留空自动归类）
            </button>
          )}
          {filtered.map((m) => (
            <button
              type="button"
              class={`msel-opt${exact?.id === m.id ? ' on' : ''}`}
              key={m.id}
              onClick={() => pick(m.slug)}
            >
              <span class="msel-name">{m.displayName}</span>
              <span class="msel-slug">{m.slug}</span>
              <span class={`badge ${m.agent === 'codex' ? 'b-ai' : 'b-gray'}`}>{m.agent}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div class="msel-empty">
              无匹配模块——将以「{trimmed}」新建（英文名直接建，中文名自动生成英文 slug）
            </div>
          )}
        </div>
      )}
    </div>
  );
}
