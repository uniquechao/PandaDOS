---
name: publish-github
description: Use when publishing, releasing, or updating the sanitized PandaDOS public GitHub repository from the private panda workspace, including requests to publish GitHub, sync public code, create a version, write release notes, or push main.
---

# Publish GitHub

## Overview

Publish the private repository's latest SemVer Tag as a sanitized, independently versioned public
release. Never publish private `HEAD`, the worktree, private Git history, or raw Issue records.

## Repository contract

| Role | Location |
|---|---|
| Private source | Locate the current PandaDOS repository root from the working directory |
| Public repository | `<private-source>/panda_ai_public` |
| Public remote | `git@github.com:uniquechao/PandaDOS.git` |
| Public branch | `main` |

## Select the source Tag

1. Read private instructions and inspect both repositories. Preserve unrelated changes.
2. Read tags published on the private `origin` and refresh the matching local refs. Consider only
   remote tags matching SemVer `vMAJOR.MINOR.PATCH` with an optional prerelease/build suffix; ignore
   local-only tags. Unless the user names a Tag, select the highest version using Git's version
   sort. Never fall back to `HEAD` or `package.json` when no matching remote Tag exists.
3. Set `source_tag` to that Tag and dereference it to `source_sha`. Read every source file with
   `git show`, `git archive`, or another operation explicitly bound to `source_tag` or `source_sha`.
   Ignore private commits after the Tag and all staged, unstaged, and untracked files.
4. Require `source_tag` without its leading `v` to equal the `package.json` version stored at that
   Tag. Stop on a mismatch.
5. Require a clean public worktree, independent `.git`, branch `main`, and the exact remote above.
   If the public Tag or GitHub Release already exists, report that the version is published and do
   not recreate or move it.

## Build the public tree

Materialize `source_tag` inside a temporary `.release-work/` directory under the private repository,
then selectively update the public tree. Preserve public-only README, screenshots, `.gitignore`,
`LICENSE`, `CLAUDE.md`, and `AGENTS.md` unless intentionally updating them.

Never copy `.git/`, `.panda/`, `.claude/`, `.env*`, admin tokens, private
keys, credentials, databases, logs, backups, sessions, or raw screenshots. Replace real domains,
users, email addresses, machine paths, hosts, IPs, project IDs, tokens, and production data with
obvious examples. Visually inspect every changed image. Remove `.release-work/` before completion.

## Generate version Release notes

Use only Issue data committed at `source_tag`.

1. Find the newest SemVer Tag already released in the public repository.
2. For the first release, consider all Issue pages at `source_tag`. For later releases, consider
   Issue pages added or changed between the previous public Tag and `source_tag` in the private
   repository. This naturally combines skipped private versions into the newest public Release.
3. Include only Issues whose metadata status at `source_tag` is `done`. Deduplicate by Issue ID.
   Use “结果与遗留事项” as the primary source and the title as fallback. Use commit messages only
   to cross-check coverage.
4. Summarize outcomes; never copy prompts, terminal logs, internal reasoning, private Issue IDs,
   production identifiers, or credentials.
5. Write `docs/releases/<source_tag>.md` in the public repository with this shape:

   ```markdown
   # PandaDOS <source_tag>
   ## 版本亮点
   ## 新功能
   ## 改进
   ## 修复
   ## 升级说明
   ```

   Omit empty sections. Combine related Issues into user-facing capabilities instead of listing
   implementation chronology.

## Validate and publish

Run checks proportional to the code change, plus `git diff --check`, the full public diff, a staged
secret/identifier scan, and visual inspection of binaries. Stage only named reviewed files; never
use `git add .`. Commit and push `main` without amending, rewriting history, or force-pushing.

Create the GitHub Release from the committed notes:

```bash
gh release create "<source_tag>" \
  --repo uniquechao/PandaDOS \
  --title "PandaDOS <source_tag>" \
  --notes-file "docs/releases/<source_tag>.md"
```

Verify public `HEAD == origin/main`, the public worktree is clean, the GitHub Release targets the
same name as `source_tag`, and the private Tag still dereferences to `source_sha`. Report the private
Tag and source commit, public commit, and Release URL.

## Stop conditions

- Credentials or private keys appear: stop and require revocation or rotation.
- No private SemVer Tag exists, or path, remote, branch, Tag, version, or release state is unexpected.
- Issue scope cannot be derived from committed history.
- Tests, build, sanitization, push, or Release creation fails.

## Common mistakes

- Publishing private `HEAD` or commits newer than the selected Tag.
- Copying private Issue pages instead of summarizing their outcomes.
- Repeating every historical Issue in every Release.
- Selecting a Tag by creation date instead of SemVer version order.
- Treating `.gitignore` as protection for already tracked secrets.
