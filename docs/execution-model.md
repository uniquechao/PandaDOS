# Execution Model: Issues, Conversations, tmux, Agents, and Terminals

[简体中文](execution-model.zh-CN.md)

The central rule is **processes are not conversations**:

```text
issue -> optional module -> persistent conversation/session id
      -> replaceable tmux container -> Claude Code or Codex process
      -> terminal as a live view into that same tmux session
```

## Ownership and identity

| Layer | Persistent identity | Main constraint |
| --- | --- | --- |
| Project | working directory + executor | Filesystem access crosses `ExecutorDriver` |
| Issue | database row + event state machine | Holds a conversation id, not a process |
| Module | project module id | Uses one agent and reuses one conversation sequentially |
| Conversation | CLI session id | Survives service and tmux restarts |
| tmux session | computed session name | Replaceable runtime container |

Claude resumes with `claude --resume <id>` and Codex with `codex resume <id>`. Killing tmux therefore does not discard conversation context.

## Session names

| Pattern | Purpose |
| --- | --- |
| `cc-<project>` | Project issue session |
| `cc-<project>-m-<slug>` | On-demand module session |
| `chat-<conversation>` | Independent project chat |
| `cc-<project>-console` | Native shell terminal |
| `clr-<issue>`, `org-<project>`, `sum-<project>` | One-shot clarification, organization, and summary work |

Names are computed by the control plane and must never be guessed. New sessions use a 220x50 terminal to avoid wrapped CLI choices.

## Issue lifecycle and scheduling

The normal state path is `pending -> planning -> implementing -> testing -> done`; any phase may become blocked. Transitions are pure, validated, persisted as events, and applied through one engine boundary. A project runs one issue at a time. Queue priority is manual pinning, then same-module grouping, then FIFO.

An issue reuses its existing conversation, otherwise its module conversation, otherwise an available debug conversation when eligible, and finally a new conversation. Module identity is the module id; display slugs are never scheduling keys.

## Engine heartbeat

Every tick the engine verifies conversation ownership, captures the pane, recovers dead tmux sessions, handles agent menus, injects a phase prompt once, tails structured JSONL output, parses sentinels, and applies nudge/fallback rules. A dead tmux session is recreated and the persistent conversation is resumed. A stale Codex JSONL binding is reclaimed without replaying old output.

All automated input paths share a per-tmux mutex. Menu actions recapture the screen and compare a signature before sending keys. Lock order is always project then tmux.

## Observation and input

- JSONL provides structured conversation events and uses byte-safe incremental tailing.
- Pane capture detects menus, prompts, update dialogs, and dead agents.
- Controlled injection strips control characters, truncates to 2,000 characters, waits 300 ms, then sends Enter.
- The browser PTY is raw and bidirectional; user keystrokes affect the live agent.

The UI does not translate issue text, code, terminal output, Git data, or existing chat content. It localizes only product-owned controls and generated explanations around that content.

## Recovery

The service can rebuild dead sessions, resume module conversations after sleep, reclaim stale Codex sessions, surface stuck menus, and recover pending clarification analysis. Backend deployment should still happen during a quiet period because a restart interrupts active injection and analysis.

Key implementation points are `src/core/conversations.ts`, `src/core/jsonl.ts`, `src/core/agent-locator.ts`, `src/issues/engine.ts`, `src/issues/machine.ts`, `src/issues/queue.ts`, `src/web/ws/`, and `src/executor/driver.ts`.
