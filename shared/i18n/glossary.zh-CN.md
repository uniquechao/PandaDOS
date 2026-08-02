# MandoAI 本地化术语表

[English](glossary.md)

所有语言都应保持品牌名、命令、路径、协议值和代码标识符不变。

| 英文概念 | 简体中文 | 繁體中文 | 日本語 | 한국어 | Español | Français | Deutsch | Português (Brasil) | Русский |
|---|---|---|---|---|---|---|---|---|---|
| issue | issue | issue | issue | issue | issue | issue | Issue | issue | задача |
| agent | Agent | Agent | エージェント | 에이전트 | agente | agent | Agent | agente | агент |
| workspace | 工作区 | 工作區 | ワークスペース | 작업 공간 | espacio de trabajo | espace de travail | Arbeitsbereich | espaço de trabalho | рабочая область |
| review | 评审 | 審查 | レビュー | 검토 | revisión | revue | Prüfung | revisão | проверка |
| terminal | 终端 | 終端機 | ターミナル | 터미널 | terminal | terminal | Terminal | terminal | терминал |
| project | 项目 | 專案 | プロジェクト | 프로젝트 | proyecto | projet | Projekt | projeto | проект |

文案应简洁、自然。Claude、Codex、tmux、Git、分支名、命令、文件路径、JSON 字段和状态机哨兵不得翻译。

## 语气与文风

采用冷静、直接的产品语言。按钮以动作开头；错误信息应说明失败内容，并在已知时告诉用户下一步怎么做。不要逐字照搬英语句式。

| 语言 | 产品文风 |
|---|---|
| `en` | 简洁、中性的国际英语。 |
| `zh-Hans` | 友好、直接，以“你”称呼用户。 |
| `zh-Hant` | 自然的繁体中文，以「你」称呼用户，并统一使用「專案」「審查」等术语。 |
| `ja` | 使用礼貌的「です／ます」体，避免生硬的直译命令句。 |
| `ko` | 统一使用礼貌的「합니다／해 주세요」体。 |
| `es` | 使用中性的国际西班牙语，并统一采用 `tú` 形式。 |
| `fr` | 使用专业语气，并统一采用 `vous` 形式。 |
| `de` | 使用专业语气，并统一采用 `Sie` 形式。 |
| `pt-BR` | 使用自然的巴西葡萄牙语，并统一采用 `você` 形式。 |
| `ru` | 使用中性、专业的俄语，优先采用清晰的无人称指令或统一的礼貌形式。 |

发布前逐语言检查术语一致性、语域、未翻译的英语句子、ICU 参数、标点和文本膨胀。只有品牌、协议、代码标识符和已经约定俗成的技术术语可以与英语保持相同。
