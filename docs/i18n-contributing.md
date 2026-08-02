# Localization Contributing Guide

[简体中文](i18n-contributing.zh-CN.md)

English (`en`) is the source catalog and runtime fallback. Launch locales are `en`, `zh-Hans`, `zh-Hant`, `ja`, `ko`, `es`, `fr`, `de`, `pt-BR`, and `ru`.

Product-owned UI, buttons, placeholders, validation and error messages, confirmations, notifications, emails, and Feishu cards must use semantic message keys. Never translate user-authored issue text, code, terminal output, Git content, file paths, commands, protocol markers, or existing chat history.

Follow the [localization glossary and voice guide](../shared/i18n/glossary.md). Every release locale requires a human terminology and tone review; English-identical values must be limited to approved technical terms and identifiers.

Use ICU arguments for dynamic values and preserve every argument name in every locale. Use the shared date, number, relative-time, and timezone formatters instead of concatenating localized fragments. Account locale and timezone take precedence; browser detection is only the first-use default, and English is the final fallback.

Chinese users receive Chinese AI system prompts. Every other locale receives English internal prompts plus an explicit output-language contract for the selected locale. Generated clarification, summary, and approval explanations follow the selected locale while quoted technical material remains verbatim.

Before submitting a change:

```bash
bun run check-i18n
bun run typecheck
bun test
bun run build-ui
```

`check-i18n` validates catalog key parity, ICU arguments, syntax, locale resolution, formatting, and pseudo-localization. Use `pseudoCatalog()` during UI development to expose clipping and hard-coded visible text. New user-visible literals should be moved to a catalog; the TypeScript scanner in `shared/i18n/guard.ts` supports targeted CI checks and explicit allowlists for brand or protocol tokens.

Public user documentation is English by default with a peer `*.zh-CN.md` document. Internal design and implementation-plan documents are written in Chinese and must remain in the ignored local `.private/` directory; they must never be committed to a public branch.
