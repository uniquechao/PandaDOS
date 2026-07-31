# Public README Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the public landing README with an English, product-led introduction and add a structurally equivalent Simplified Chinese README that helps visitors self-host Mando AI quickly.

**Architecture:** Keep all product positioning, installation, feature, architecture, deployment, and security information in two parallel Markdown files. Reuse the existing sanitized screenshots and existing repository documentation; do not add runtime code, dependencies, hosted-demo claims, or private identifiers.

**Tech Stack:** GitHub-flavored Markdown, existing PNG screenshots, Bun package scripts, shell-based document validation.

## Global Constraints

- `README.md` is the canonical English landing page.
- `README.zh-CN.md` is a complete Simplified Chinese translation with equivalent headings, commands, screenshots, links, and safety guidance.
- Lead with self-hosted Quick Start before architecture details.
- Reuse only `docs/images/mando-workspace-overview.png` and `docs/images/mando-issue-workflow.png`.
- Do not add fake badges, hosted demos, private URLs, real identities, machine paths, credentials, or unsupported capabilities.
- Keep the documented start sequence exactly aligned with `package.json`: `bun install --frozen-lockfile`, `bun run build-ui`, and `bun run start`.
- Production details continue to live in `DEPLOY.md`; architecture details continue to live in `docs/architecture.md`.

---

### Task 1: English product-led README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: `package.json` scripts, `DEPLOY.md`, `docs/architecture.md`, and the two sanitized screenshots.
- Produces: English headings and anchors mirrored by Task 2.

- [ ] **Step 1: Replace the hero and navigation**

Write an English title, the approved self-hosted Claude Code/Codex positioning, language links, compact section links, the sanitized workspace image, and an explicit illustrative-data caption.

- [ ] **Step 2: Put Quick Start directly after the hero**

Document Bun, Git, tmux, and authenticated Claude Code/Codex requirements. Include this exact sequence:

```bash
git clone https://github.com/uniquechao/MandoAI.git
cd MandoAI
bun install --frozen-lockfile
bun run build-ui
bun run start
```

State that the local service opens at `http://127.0.0.1:8802` and explain the one-time local administrator token without showing a token value.

- [ ] **Step 3: Add product highlights and operating model**

Describe the six approved capabilities: Issue workflow, Claude Code and Codex, browser workspace, approval levels, local/SSH executors, and team-ready projects. Add the approved control-plane flow and the sanitized Issue workflow image.

- [ ] **Step 4: Retain concise technical and safety references**

Keep the dependency-direction diagram, compact directory table, deployment link, security warnings, development commands, contributor guidance, and Apache 2.0 license link.

- [ ] **Step 5: Check the English document**

Run:

```bash
git diff --check -- README.md
rg -n '^## ' README.md
```

Expected: no whitespace errors; sections appear in the design order.

### Task 2: Complete Simplified Chinese README

**Files:**
- Create: `README.zh-CN.md`

**Interfaces:**
- Consumes: the final `README.md` structure and exact commands from Task 1.
- Produces: a complete Chinese counterpart linked from `README.md`.

- [ ] **Step 1: Translate the full document**

Create a natural Simplified Chinese translation of every English section. Preserve Markdown structure, code blocks, image paths, local URLs, repository URLs, and relative documentation links exactly.

- [ ] **Step 2: Add reciprocal language navigation**

Link `README.zh-CN.md` to `README.md` at the top, and confirm `README.md` links back to `README.zh-CN.md`.

- [ ] **Step 3: Check bilingual parity**

Run one bounded script that compares heading counts, fenced code-block counts, image paths, repository URLs, local URLs, and the three Bun commands across both documents.

Expected: equal structural counts and identical commands/asset paths.

### Task 3: Public documentation validation and publication

**Files:**
- Modify: `README.md`
- Create: `README.zh-CN.md`

**Interfaces:**
- Consumes: completed outputs from Tasks 1 and 2.
- Produces: reviewed public-repository commit on `main`.

- [ ] **Step 1: Validate links and documented scripts**

Verify that `README.md`, `README.zh-CN.md`, `DEPLOY.md`, `docs/architecture.md`, `LICENSE`, `AGENTS.md`, `CLAUDE.md`, and both screenshot paths exist. Verify `package.json` defines `start`, `build-ui`, and `typecheck`.

- [ ] **Step 2: Scan both documents for private identifiers and secrets**

Search for real local usernames, production domains, private email domains, private-key headers, common GitHub/OpenAI token shapes, non-example administrator tokens, and non-example absolute machine paths.

Expected: zero matches.

- [ ] **Step 3: Review and stage only named files**

Run `git diff --check`, review the full diff, and stage only:

```bash
git add README.md README.zh-CN.md docs/superpowers/plans/2026-08-01-public-readme-refresh.md
```

- [ ] **Step 4: Commit and update GitHub**

Commit with:

```bash
git commit -m "docs: refresh bilingual public README"
git push origin main
```

- [ ] **Step 5: Verify publication**

Confirm local `HEAD` equals `origin/main`, the public worktree is clean, both README files are present in the remote commit, and the existing `v0.1.0` tag remains unchanged.
