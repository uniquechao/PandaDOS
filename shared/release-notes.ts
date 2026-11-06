import type { MessageKey } from './i18n/messages';

export const RELEASE_NOTE_KEYS = {
  'issue-list-pagination': 'release.note.issueListPagination',
  'sticky-user-question': 'release.note.stickyUserQuestion',
  'agent-conversation-titles': 'release.note.agentConversationTitles',
  'idle-chat-hibernation': 'release.note.idleChatHibernation',
  'local-plan-workspace': 'release.note.localPlanWorkspace',
  'executor-environment-recovery': 'release.note.executorEnvironmentRecovery',
  'issue-stop-diagnostics': 'release.note.issueStopDiagnostics',
  'host-build-release': 'release.note.hostBuildRelease',
} as const satisfies Record<string, MessageKey>;
