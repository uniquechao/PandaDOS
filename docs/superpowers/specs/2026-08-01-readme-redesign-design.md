# MandoAI Public README Redesign

## Objective

Redesign the public repository introduction using the product-led information architecture of the
OpenClaw README as a reference, without copying its wording or presenting unsupported MandoAI
capabilities.

The primary README will be English. A complete Simplified Chinese version will be provided in
`README.zh-CN.md`. Both documents will share the same structure and link to each other.

The primary success criterion is that a first-time visitor can understand what MandoAI does and
reach a working self-hosted instance with minimal scrolling.

## Audience and positioning

The primary audience is developers and engineering teams who already use Claude Code or Codex and
want a self-hosted control plane for queueing, observing, and approving agent work.

Proposed title:

> MandoAI — Issue-driven coding agent orchestration

Proposed lead:

> Your self-hosted control plane for Claude Code and Codex. Turn issues into queued, observable,
> approval-aware coding workflows—from any browser.

The introduction must state that MandoAI is not an AI model. It sits between users and coding-agent
CLIs to coordinate issues, sessions, approvals, notifications, recovery, files, terminals, and Git.

## Information architecture

The English and Chinese READMEs will use this order:

1. Product title and one-sentence positioning
2. Language switch and compact navigation links
3. Sanitized workspace overview screenshot
4. Install and Quick Start
5. Product highlights
6. How it works
7. Sanitized Issue workflow screenshot
8. Architecture overview
9. Deployment and security guidance
10. Development, contributing, and license

This order puts the user outcome and runnable path before implementation details.

## Hero and navigation

The hero will include:

- The product title and concise English positioning
- `English · 简体中文` language links
- In-page links for Quick Start, Features, Architecture, Deployment, and Security
- The existing sanitized workspace overview image
- A short disclosure that all visible project, user, Issue, and branch data is illustrative

The README will not add fake badges, unavailable hosted demos, private production URLs, or links to
documentation that does not exist.

## Quick Start

The shortest supported source installation path will appear immediately after the hero:

```bash
git clone https://github.com/uniquechao/MandoAI.git
cd MandoAI
bun install --frozen-lockfile
bun run build-ui
bun run start
```

The surrounding text will state:

- Requirements: Bun, Git, tmux, and a logged-in Claude Code or Codex CLI
- Local URL: `http://127.0.0.1:8802`
- The first-run administrator token is written locally with restrictive permissions
- Production deployment details belong in `DEPLOY.md`

## Product highlights

The feature section will be concise and outcome-oriented:

1. **Issue-to-execution workflow** — queueing, clarification, planning, execution, validation, and
   handoff.
2. **Claude Code and Codex** — select an agent by project or module and reuse persistent context.
3. **Browser-native workspace** — conversations, terminals, files, screenshots, and Git in one UI.
4. **Human-in-the-loop approvals** — cautious, balanced, and automatic approval levels.
5. **Local and SSH executors** — run agents on the local machine or registered remote hosts.
6. **Team-ready projects** — members, modules, notifications, project summaries, and parallel
   projects.

Claims must match the current public source. The section must not imply SaaS hosting, sandboxing, or
provider support that the repository does not currently deliver.

## How it works and screenshots

The operating model will be shown as a compact text diagram:

```text
User / Browser / Notifications
              ↓
     MandoAI control plane
              ↓
Issues · approvals · sessions · files · Git
              ↓
       Local or SSH executor
              ↓
      tmux → Claude Code / Codex
```

The existing sanitized Issue workflow screenshot will support this explanation. Screenshots will be
used to demonstrate the workspace and execution flow rather than as decorative repetition.

## Architecture and operations

The architecture section will retain the dependency rule:

```text
core ← executor ← issues ← agents
  ↑
web / notify
```

It will keep a compact directory responsibility table and link to `docs/architecture.md` for deeper
detail.

The deployment section will cover only the safe local default and point to `DEPLOY.md` for reverse
proxy, SSH executor, and production configuration guidance.

The security section will explicitly state:

- Browser terminal and file access are equivalent to remote shell access
- The service should bind to loopback by default
- Public access requires trusted TLS termination and authentication
- `.env`, databases, administrator tokens, SSH private keys, credentials, and agent session data
  must never be committed
- Executors should use dedicated accounts and least privilege

## Bilingual maintenance

`README.md` and `README.zh-CN.md` will have equivalent headings, links, commands, screenshots, and
safety statements. English will be the canonical public landing page; the Chinese document will be
a complete translation, not an abbreviated summary.

Future behavior changes that affect installation, features, or security must update both files in
the same commit.

## Validation

Because this change is documentation-only, validation will include:

- `git diff --check`
- Verification that all relative links and image paths resolve
- Verification that every documented command exists in `package.json`
- English/Chinese heading and command parity check
- Identifier and secret scan over both README files
- Review of the rendered Markdown structure on GitHub-compatible Markdown

No product tests or build are required unless README changes reveal or require a source change.
