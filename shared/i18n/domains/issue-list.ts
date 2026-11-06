import type { SupportedLocale } from '../locales';

export const issueListMessages = {
  "en": {
    "board.listLoadFailed": "Could not load issues. Existing results are kept. Retry to refresh.",
    "errors.issues.list_invalid": "Invalid issue list query.",
    "release.note.issueListPagination": "Load issue summaries by status with server pagination, non-overlapping polls and retry on failure.",
    "release.note.stickyUserQuestion": "Keep the question for the conversation round being read visible as you scroll.",
    "release.note.agentConversationTitles": "Synchronize conversation names with Agent titles while preserving manual names."
  },
  "zh-Hans": {
    "board.listLoadFailed": "无法加载任务，已有结果仍保留，请重试刷新。",
    "errors.issues.list_invalid": "任务列表查询参数无效。",
    "release.note.issueListPagination": "按状态加载任务摘要，后端分页，轮询不重叠，失败后可重试。",
    "release.note.stickyUserQuestion": "滚动阅读对话时，吸顶显示当前轮次的用户提问。",
    "release.note.agentConversationTitles": "对话名称同步 Agent 标题，并保留用户手动命名。"
  },
  "zh-Hant": {
    "board.listLoadFailed": "無法載入任務，已有結果仍保留，請重試更新。",
    "errors.issues.list_invalid": "任務清單查詢參數無效。",
    "release.note.issueListPagination": "依狀態載入任務摘要，後端分頁，輪詢不重疊，失敗後可重試。",
    "release.note.stickyUserQuestion": "捲動閱讀對話時，在頂端固定顯示目前輪次的提問。",
    "release.note.agentConversationTitles": "對話名稱同步 Agent 標題，並保留使用者手動命名。"
  },
  "ja": {
    "board.listLoadFailed": "issue を読み込めませんでした。既存の結果は保持されます。再試行してください。",
    "errors.issues.list_invalid": "issue 一覧の検索条件が無効です。",
    "release.note.issueListPagination": "状態別の issue 概要とサーバーページ分割に対応し、重複ポーリングを防ぎ、失敗時に再試行できます。",
    "release.note.stickyUserQuestion": "スクロール中も、読んでいる会話の質問を上部に固定表示します。",
    "release.note.agentConversationTitles": "手動で設定した名前を保持しながら、会話名をエージェントのタイトルと同期します。"
  },
  "ko": {
    "board.listLoadFailed": "issue를 불러오지 못했습니다. 기존 결과는 유지됩니다. 다시 시도해 주세요.",
    "errors.issues.list_invalid": "issue 목록 조회 조건이 올바르지 않습니다.",
    "release.note.issueListPagination": "상태별 issue 요약과 서버 페이지 나누기를 지원하며 중복 폴링 없이 실패한 요청을 다시 시도할 수 있습니다.",
    "release.note.stickyUserQuestion": "스크롤해도 읽고 있는 대화 차례의 질문이 상단에 고정됩니다.",
    "release.note.agentConversationTitles": "직접 지정한 이름은 유지하면서 대화 이름을 에이전트 제목과 동기화합니다."
  },
  "es": {
    "board.listLoadFailed": "No se pudieron cargar los issues. Se conservan los resultados anteriores. Vuelve a intentarlo.",
    "errors.issues.list_invalid": "La consulta de issues no es válida.",
    "release.note.issueListPagination": "Carga resúmenes por estado con paginación del servidor, sin sondeos superpuestos y con reintentos.",
    "release.note.stickyUserQuestion": "Mantén visible la pregunta del turno que estás leyendo al desplazarte.",
    "release.note.agentConversationTitles": "Sincroniza los nombres de conversación con los títulos del agente y conserva los nombres manuales."
  },
  "fr": {
    "board.listLoadFailed": "Impossible de charger les issues. Les résultats précédents sont conservés. Réessayez.",
    "errors.issues.list_invalid": "La requête de liste des issues est invalide.",
    "release.note.issueListPagination": "Chargez les résumés par état avec pagination côté serveur, sans interrogations simultanées et avec nouvelle tentative en cas d’échec.",
    "release.note.stickyUserQuestion": "Gardez visible la question du tour de conversation que vous lisez en faisant défiler.",
    "release.note.agentConversationTitles": "Synchronisez les noms des conversations avec les titres de l’agent tout en conservant les noms manuels."
  },
  "de": {
    "board.listLoadFailed": "Issues konnten nicht geladen werden. Vorhandene Ergebnisse bleiben erhalten. Versuchen Sie es erneut.",
    "errors.issues.list_invalid": "Die Abfrage der Issue-Liste ist ungültig.",
    "release.note.issueListPagination": "Laden Sie Issue-Zusammenfassungen nach Status seitenweise vom Server, mit Wiederholungen ohne überlappende Abfragen.",
    "release.note.stickyUserQuestion": "Die Frage der gerade gelesenen Gesprächsrunde bleibt beim Scrollen oben sichtbar.",
    "release.note.agentConversationTitles": "Gesprächsnamen werden mit Agent-Titeln synchronisiert; manuell vergebene Namen bleiben erhalten."
  },
  "pt-BR": {
    "board.listLoadFailed": "Não foi possível carregar os issues. Os resultados anteriores foram mantidos. Tente novamente.",
    "errors.issues.list_invalid": "A consulta da lista de issues é inválida.",
    "release.note.issueListPagination": "Carregue resumos por status com paginação do servidor, sem consultas sobrepostas e com novas tentativas em caso de falha.",
    "release.note.stickyUserQuestion": "Mantenha visível a pergunta da rodada que você está lendo ao rolar a conversa.",
    "release.note.agentConversationTitles": "Sincronize os nomes das conversas com os títulos do agente, preservando os nomes definidos manualmente."
  },
  "ru": {
    "board.listLoadFailed": "Не удалось загрузить задачи. Предыдущие результаты сохранены. Повторите попытку.",
    "errors.issues.list_invalid": "Недопустимые параметры запроса списка задач.",
    "release.note.issueListPagination": "Загружайте краткие сведения по статусам постранично с сервера без перекрывающихся опросов, с повтором при ошибке.",
    "release.note.stickyUserQuestion": "При прокрутке вопрос просматриваемого хода диалога остаётся закреплённым вверху.",
    "release.note.agentConversationTitles": "Названия диалогов синхронизируются с заголовками агента, а заданные вручную имена сохраняются."
  }
} as const satisfies Record<SupportedLocale, Record<string, string>>;
