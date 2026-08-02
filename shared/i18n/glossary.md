# MandoAI localization glossary

[简体中文](glossary.zh-CN.md)

Brand names, commands, paths, protocol values, and code identifiers stay unchanged in every locale.

| English concept | 简体中文 | 繁體中文 | 日本語 | 한국어 | Español | Français | Deutsch | Português (Brasil) | Русский |
|---|---|---|---|---|---|---|---|---|---|
| issue | issue | issue | issue | issue | issue | issue | Issue | issue | задача |
| agent | Agent | Agent | エージェント | 에이전트 | agente | agent | Agent | agente | агент |
| workspace | 工作区 | 工作區 | ワークスペース | 작업 공간 | espacio de trabajo | espace de travail | Arbeitsbereich | espaço de trabalho | рабочая область |
| review | 评审 | 審查 | レビュー | 검토 | revisión | revue | Prüfung | revisão | проверка |
| terminal | 终端 | 終端機 | ターミナル | 터미널 | terminal | terminal | Terminal | terminal | терминал |
| project | 项目 | 專案 | プロジェクト | 프로젝트 | proyecto | projet | Projekt | projeto | проект |

Use concise, natural product language. Do not translate Claude, Codex, tmux, Git, branch names, commands, file paths, JSON fields, or state-machine sentinels.

## Voice and tone

Use calm, direct product language. Buttons start with an action; errors explain what failed and, when known, what the user can do next. Do not translate sentence structure literally from English.

| Locale | Product voice |
|---|---|
| `en` | Concise, neutral international English. |
| `zh-Hans` | Friendly and direct; address the user as “你”. |
| `zh-Hant` | Natural Traditional Chinese; address the user as “你” and use terms such as “專案” and “審查” consistently. |
| `ja` | Polite `です／ます` style; avoid blunt literal imperatives. |
| `ko` | Consistent polite `합니다／해 주세요` style. |
| `es` | Neutral international Spanish with consistent `tú` forms. |
| `fr` | Professional French with consistent `vous` forms. |
| `de` | Professional German with consistent `Sie` forms. |
| `pt-BR` | Natural Brazilian Portuguese with consistent `você` forms. |
| `ru` | Neutral, professional Russian; prefer clear impersonal instructions or consistent polite forms. |

Before release, review each catalog for glossary consistency, register, untranslated English prose, ICU arguments, punctuation, and text expansion. Identical English values are allowed only for brands, protocols, code identifiers, and established technical terms.
