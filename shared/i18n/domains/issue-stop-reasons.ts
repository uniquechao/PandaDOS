import type { SupportedLocale } from '../locales';

export const issueStopReasonMessages = {
  en: {
    'issue.stopBranchMismatch': 'Working branch mismatch',
    'issue.stopBranchReason': 'The workspace uses “{actual}”, but the task is bound to “{expected}”. Execution was paused to avoid using the wrong code.',
    'issue.stopBranchAction': 'Confirm the intended baseline, align the workspace branch and task binding, then resume. Retrying alone will not fix the mismatch.',
    'issue.stopConcreteReason': 'Specific cause: {reason}',
  },
  'zh-Hans': {
    'issue.stopBranchMismatch': '工作分支不一致',
    'issue.stopBranchReason': '执行现场使用「{actual}」，系统登记为「{expected}」。分支不一致，任务已暂停以避免使用错误代码。',
    'issue.stopBranchAction': '先确认要使用的基线，再统一工作区分支与任务绑定后恢复；单独重试不会解决分支不一致。',
    'issue.stopConcreteReason': '具体原因：{reason}',
  },
  'zh-Hant': {
    'issue.stopBranchMismatch': '工作分支不一致',
    'issue.stopBranchReason': '工作區使用「{actual}」，系統登記為「{expected}」。分支不一致，任務已暫停，避免使用錯誤的程式碼。',
    'issue.stopBranchAction': '請先確認要使用的基線，統一工作區分支與任務綁定後再恢復；單獨重試無法解決分支不一致。',
    'issue.stopConcreteReason': '具體原因：{reason}',
  },
  ja: {
    'issue.stopBranchMismatch': '作業ブランチの不一致',
    'issue.stopBranchReason': '作業環境は「{actual}」を使用していますが、タスクには「{expected}」が登録されています。誤ったコードの使用を防ぐため、一時停止しました。',
    'issue.stopBranchAction': '使用する基準を確認し、作業環境のブランチとタスクの登録を一致させてから再開してください。再試行だけでは解決しません。',
    'issue.stopConcreteReason': '具体的な原因：{reason}',
  },
  ko: {
    'issue.stopBranchMismatch': '작업 브랜치 불일치',
    'issue.stopBranchReason': '작업 환경은 “{actual}”을 사용하지만 작업에는 “{expected}”가 등록되어 있습니다. 잘못된 코드 사용을 방지하기 위해 일시 중지했습니다.',
    'issue.stopBranchAction': '사용할 기준을 확인하고 작업 환경의 브랜치와 작업에 등록된 브랜치를 일치시킨 후 재개해 주세요. 재시도만으로는 해결되지 않습니다.',
    'issue.stopConcreteReason': '구체적인 원인: {reason}',
  },
  es: {
    'issue.stopBranchMismatch': 'Las ramas de trabajo no coinciden',
    'issue.stopBranchReason': 'El entorno usa «{actual}», pero la tarea tiene asignada «{expected}». La ejecución se pausó para evitar usar código incorrecto.',
    'issue.stopBranchAction': 'Confirma la base que quieres usar, haz coincidir la rama del entorno con la asignada a la tarea y reanuda. Volver a intentarlo no resuelve la diferencia.',
    'issue.stopConcreteReason': 'Causa concreta: {reason}',
  },
  fr: {
    'issue.stopBranchMismatch': 'Les branches de travail diffèrent',
    'issue.stopBranchReason': 'L’environnement utilise « {actual} », mais la tâche est liée à « {expected} ». L’exécution a été suspendue pour éviter d’utiliser un code incorrect.',
    'issue.stopBranchAction': 'Confirmez la base souhaitée, alignez la branche de l’environnement et celle liée à la tâche, puis reprenez. Réessayer seul ne résoudra pas cet écart.',
    'issue.stopConcreteReason': 'Cause précise : {reason}',
  },
  de: {
    'issue.stopBranchMismatch': 'Abweichender Arbeitsbranch',
    'issue.stopBranchReason': 'Die Arbeitsumgebung verwendet „{actual}“, der Aufgabe ist jedoch „{expected}“ zugeordnet. Die Ausführung wurde angehalten, um falschen Code zu vermeiden.',
    'issue.stopBranchAction': 'Bestätigen Sie die gewünschte Basis, gleichen Sie den Branch der Arbeitsumgebung und die Aufgabenzuordnung ab und setzen Sie dann fort. Ein erneuter Versuch allein behebt die Abweichung nicht.',
    'issue.stopConcreteReason': 'Konkrete Ursache: {reason}',
  },
  'pt-BR': {
    'issue.stopBranchMismatch': 'As branches de trabalho não coincidem',
    'issue.stopBranchReason': 'O ambiente usa “{actual}”, mas a tarefa está vinculada a “{expected}”. A execução foi pausada para evitar o uso do código errado.',
    'issue.stopBranchAction': 'Confirme a base desejada, alinhe a branch do ambiente com a vinculada à tarefa e retome. Tentar novamente sem esse ajuste não resolve a diferença.',
    'issue.stopConcreteReason': 'Causa específica: {reason}',
  },
  ru: {
    'issue.stopBranchMismatch': 'Несовпадение рабочей ветки',
    'issue.stopBranchReason': 'Рабочее окружение использует «{actual}», а для задачи задана ветка «{expected}». Выполнение приостановлено, чтобы не использовать неверный код.',
    'issue.stopBranchAction': 'Уточните нужную основу, согласуйте ветку окружения с веткой задачи и возобновите выполнение. Простой повтор не устранит несовпадение.',
    'issue.stopConcreteReason': 'Конкретная причина: {reason}',
  },
} as const satisfies Record<SupportedLocale, Record<string, string>>;
