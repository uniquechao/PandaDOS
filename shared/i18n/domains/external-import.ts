import type { SupportedLocale } from '../locales';

const en = {
  'externalImport.title': 'Import external issues',
  'externalImport.description': 'Fetch open issues on demand, review and edit them, then import them into the project queue.',
  'externalImport.fetch': 'Fetch open issues',
  'externalImport.fetching': 'Fetching…',
  'externalImport.configureFirst': 'Configure a GitHub or GitLab issue source and API token before fetching.',
  'externalImport.configureAction': 'Open project settings',
  'externalImport.source': 'Current source',
  'externalImport.idle': 'No remote request has been made. Select Fetch open issues when you are ready.',
  'externalImport.empty': 'No unhandled open issues were found.',
  'externalImport.count': '{count, plural, one {# open issue} other {# open issues}}',
  'externalImport.author': 'Author: {author}',
  'externalImport.labels': 'Labels: {labels}',
  'externalImport.created': 'Created: {time}',
  'externalImport.updated': 'Updated: {time}',
  'externalImport.openRemote': 'Open remote issue',
  'externalImport.ignore': 'Ignore',
  'externalImport.ignoreConfirm': 'Ignore remote issue #{number}? It will not appear in later fetches.',
  'externalImport.ignored': 'Remote issue #{number} ignored.',
  'externalImport.edit': 'Edit and import',
  'externalImport.confirm': 'Confirm import',
  'externalImport.importing': 'Importing…',
  'externalImport.imported': 'Remote issue #{number} imported as local issue #{id}.',
} as const;

type Keys = keyof typeof en;
type Catalog = Record<Keys, string>;

const translations: Record<Exclude<SupportedLocale, 'en'>, Catalog> = {
  'zh-Hans': {
    'externalImport.title': '导入外部 issue', 'externalImport.description': '按需获取开放 issue，查看并修改后再导入项目队列。', 'externalImport.fetch': '获取开放 issue', 'externalImport.fetching': '正在获取…',
    'externalImport.configureFirst': '获取前，请先配置 GitHub 或 GitLab issue 来源和 API token。', 'externalImport.configureAction': '打开项目配置', 'externalImport.source': '当前来源',
    'externalImport.idle': '尚未请求远端。准备好后点击“获取开放 issue”。', 'externalImport.empty': '没有待处理的开放 issue。', 'externalImport.count': '{count, plural, one {# 个开放 issue} other {# 个开放 issue}}',
    'externalImport.author': '作者：{author}', 'externalImport.labels': '标签：{labels}', 'externalImport.created': '创建时间：{time}', 'externalImport.updated': '更新时间：{time}',
    'externalImport.openRemote': '打开远端 issue', 'externalImport.ignore': '忽略', 'externalImport.ignoreConfirm': '忽略远端 issue #{number}？后续获取将不再显示它。', 'externalImport.ignored': '已忽略远端 issue #{number}。',
    'externalImport.edit': '编辑并导入', 'externalImport.confirm': '确认导入', 'externalImport.importing': '正在导入…', 'externalImport.imported': '远端 issue #{number} 已导入为本地 issue #{id}。',
  },
  'zh-Hant': {
    'externalImport.title': '匯入外部 issue', 'externalImport.description': '按需取得開放 issue，檢視並修改後再匯入專案佇列。', 'externalImport.fetch': '取得開放 issue', 'externalImport.fetching': '正在取得…',
    'externalImport.configureFirst': '取得前，請先設定 GitHub 或 GitLab issue 來源和 API token。', 'externalImport.configureAction': '開啟專案設定', 'externalImport.source': '目前來源',
    'externalImport.idle': '尚未要求遠端資料。準備好後請選擇「取得開放 issue」。', 'externalImport.empty': '沒有待處理的開放 issue。', 'externalImport.count': '{count, plural, other {# 個開放 issue}}',
    'externalImport.author': '作者：{author}', 'externalImport.labels': '標籤：{labels}', 'externalImport.created': '建立時間：{time}', 'externalImport.updated': '更新時間：{time}',
    'externalImport.openRemote': '開啟遠端 issue', 'externalImport.ignore': '忽略', 'externalImport.ignoreConfirm': '忽略遠端 issue #{number}？之後取得時將不再顯示。', 'externalImport.ignored': '已忽略遠端 issue #{number}。',
    'externalImport.edit': '編輯並匯入', 'externalImport.confirm': '確認匯入', 'externalImport.importing': '正在匯入…', 'externalImport.imported': '遠端 issue #{number} 已匯入為本機 issue #{id}。',
  },
  ja: {
    'externalImport.title': '外部 issue をインポート', 'externalImport.description': '必要なときに未解決の issue を取得し、確認・編集してからプロジェクトキューへインポートします。', 'externalImport.fetch': '未解決 issue を取得', 'externalImport.fetching': '取得中…',
    'externalImport.configureFirst': '取得する前に、GitHub または GitLab の issue ソースと API token を設定してください。', 'externalImport.configureAction': 'プロジェクト設定を開く', 'externalImport.source': '現在のソース',
    'externalImport.idle': 'まだリモートへ問い合わせていません。準備ができたら「未解決 issue を取得」を選択してください。', 'externalImport.empty': '未処理の未解決 issue はありません。', 'externalImport.count': '{count, plural, other {未解決 issue # 件}}',
    'externalImport.author': '作成者：{author}', 'externalImport.labels': 'ラベル：{labels}', 'externalImport.created': '作成日時：{time}', 'externalImport.updated': '更新日時：{time}',
    'externalImport.openRemote': 'リモート issue を開く', 'externalImport.ignore': '無視', 'externalImport.ignoreConfirm': 'リモート issue #{number} を無視しますか？以後の取得には表示されません。', 'externalImport.ignored': 'リモート issue #{number} を無視しました。',
    'externalImport.edit': '編集してインポート', 'externalImport.confirm': 'インポートを確定', 'externalImport.importing': 'インポート中…', 'externalImport.imported': 'リモート issue #{number} をローカル issue #{id} としてインポートしました。',
  },
  ko: {
    'externalImport.title': '외부 issue 가져오기', 'externalImport.description': '필요할 때 열린 issue를 가져와 검토하고 수정한 후 프로젝트 대기열에 추가합니다.', 'externalImport.fetch': '열린 issue 가져오기', 'externalImport.fetching': '가져오는 중…',
    'externalImport.configureFirst': '가져오기 전에 GitHub 또는 GitLab issue 원본과 API token을 구성하세요.', 'externalImport.configureAction': '프로젝트 설정 열기', 'externalImport.source': '현재 원본',
    'externalImport.idle': '아직 원격 요청을 보내지 않았습니다. 준비되면 열린 issue 가져오기를 선택하세요.', 'externalImport.empty': '처리할 열린 issue가 없습니다.', 'externalImport.count': '{count, plural, other {열린 issue #개}}',
    'externalImport.author': '작성자: {author}', 'externalImport.labels': '레이블: {labels}', 'externalImport.created': '생성: {time}', 'externalImport.updated': '업데이트: {time}',
    'externalImport.openRemote': '원격 issue 열기', 'externalImport.ignore': '무시', 'externalImport.ignoreConfirm': '원격 issue #{number}을(를) 무시할까요? 이후 가져오기에는 표시되지 않습니다.', 'externalImport.ignored': '원격 issue #{number}을(를) 무시했습니다.',
    'externalImport.edit': '편집 후 가져오기', 'externalImport.confirm': '가져오기 확인', 'externalImport.importing': '가져오는 중…', 'externalImport.imported': '원격 issue #{number}을(를) 로컬 issue #{id}(으)로 가져왔습니다.',
  },
  es: {
    'externalImport.title': 'Importar issues externas', 'externalImport.description': 'Obtén las issues abiertas cuando quieras, revísalas y edítalas antes de importarlas a la cola del proyecto.', 'externalImport.fetch': 'Obtener issues abiertas', 'externalImport.fetching': 'Obteniendo…',
    'externalImport.configureFirst': 'Configura un origen de issues de GitHub o GitLab y un token de API antes de obtenerlas.', 'externalImport.configureAction': 'Abrir configuración del proyecto', 'externalImport.source': 'Origen actual',
    'externalImport.idle': 'Aún no se ha consultado el remoto. Selecciona Obtener issues abiertas cuando quieras.', 'externalImport.empty': 'No se encontraron issues abiertas sin procesar.', 'externalImport.count': '{count, plural, one {# issue abierta} other {# issues abiertas}}',
    'externalImport.author': 'Autor: {author}', 'externalImport.labels': 'Etiquetas: {labels}', 'externalImport.created': 'Creada: {time}', 'externalImport.updated': 'Actualizada: {time}',
    'externalImport.openRemote': 'Abrir issue remota', 'externalImport.ignore': 'Ignorar', 'externalImport.ignoreConfirm': '¿Ignorar la issue remota #{number}? No aparecerá en futuras consultas.', 'externalImport.ignored': 'Se ignoró la issue remota #{number}.',
    'externalImport.edit': 'Editar e importar', 'externalImport.confirm': 'Confirmar importación', 'externalImport.importing': 'Importando…', 'externalImport.imported': 'La issue remota #{number} se importó como issue local #{id}.',
  },
  fr: {
    'externalImport.title': 'Importer des issues externes', 'externalImport.description': 'Récupérez les issues ouvertes à la demande, vérifiez-les et modifiez-les avant de les importer dans la file du projet.', 'externalImport.fetch': 'Récupérer les issues ouvertes', 'externalImport.fetching': 'Récupération…',
    'externalImport.configureFirst': 'Configurez une source d’issues GitHub ou GitLab et un jeton d’API avant la récupération.', 'externalImport.configureAction': 'Ouvrir les paramètres du projet', 'externalImport.source': 'Source actuelle',
    'externalImport.idle': 'Aucune requête distante n’a encore été effectuée. Sélectionnez Récupérer les issues ouvertes lorsque vous êtes prêt.', 'externalImport.empty': 'Aucune issue ouverte non traitée n’a été trouvée.', 'externalImport.count': '{count, plural, one {# issue ouverte} other {# issues ouvertes}}',
    'externalImport.author': 'Auteur : {author}', 'externalImport.labels': 'Étiquettes : {labels}', 'externalImport.created': 'Créée : {time}', 'externalImport.updated': 'Actualisée : {time}',
    'externalImport.openRemote': 'Ouvrir l’issue distante', 'externalImport.ignore': 'Ignorer', 'externalImport.ignoreConfirm': 'Ignorer l’issue distante n° {number} ? Elle n’apparaîtra plus lors des prochaines récupérations.', 'externalImport.ignored': 'L’issue distante n° {number} a été ignorée.',
    'externalImport.edit': 'Modifier et importer', 'externalImport.confirm': 'Confirmer l’importation', 'externalImport.importing': 'Importation…', 'externalImport.imported': 'L’issue distante n° {number} a été importée comme issue locale n° {id}.',
  },
  de: {
    'externalImport.title': 'Externe Issues importieren', 'externalImport.description': 'Rufen Sie offene Issues bei Bedarf ab, prüfen und bearbeiten Sie sie und importieren Sie sie anschließend in die Projektwarteschlange.', 'externalImport.fetch': 'Offene Issues abrufen', 'externalImport.fetching': 'Wird abgerufen…',
    'externalImport.configureFirst': 'Konfigurieren Sie vor dem Abruf eine GitHub- oder GitLab-Issue-Quelle und ein API-Token.', 'externalImport.configureAction': 'Projekteinstellungen öffnen', 'externalImport.source': 'Aktuelle Quelle',
    'externalImport.idle': 'Es wurde noch keine Remote-Anfrage gestellt. Wählen Sie Offene Issues abrufen, wenn Sie bereit sind.', 'externalImport.empty': 'Keine unbearbeiteten offenen Issues gefunden.', 'externalImport.count': '{count, plural, one {# offenes Issue} other {# offene Issues}}',
    'externalImport.author': 'Autor: {author}', 'externalImport.labels': 'Kennzeichnungen: {labels}', 'externalImport.created': 'Erstellt: {time}', 'externalImport.updated': 'Aktualisiert: {time}',
    'externalImport.openRemote': 'Remote-Issue öffnen', 'externalImport.ignore': 'Ignorieren', 'externalImport.ignoreConfirm': 'Remote-Issue #{number} ignorieren? Es erscheint bei späteren Abrufen nicht mehr.', 'externalImport.ignored': 'Remote-Issue #{number} ignoriert.',
    'externalImport.edit': 'Bearbeiten und importieren', 'externalImport.confirm': 'Import bestätigen', 'externalImport.importing': 'Wird importiert…', 'externalImport.imported': 'Remote-Issue #{number} wurde als lokales Issue #{id} importiert.',
  },
  'pt-BR': {
    'externalImport.title': 'Importar issues externas', 'externalImport.description': 'Busque issues abertas quando quiser, revise e edite antes de importá-las para a fila do projeto.', 'externalImport.fetch': 'Buscar issues abertas', 'externalImport.fetching': 'Buscando…',
    'externalImport.configureFirst': 'Configure uma origem de issues do GitHub ou GitLab e um token de API antes da busca.', 'externalImport.configureAction': 'Abrir configurações do projeto', 'externalImport.source': 'Origem atual',
    'externalImport.idle': 'Nenhuma solicitação remota foi feita. Selecione Buscar issues abertas quando estiver pronto.', 'externalImport.empty': 'Nenhuma issue aberta e pendente foi encontrada.', 'externalImport.count': '{count, plural, one {# issue aberta} other {# issues abertas}}',
    'externalImport.author': 'Autor: {author}', 'externalImport.labels': 'Rótulos: {labels}', 'externalImport.created': 'Criada: {time}', 'externalImport.updated': 'Atualizada: {time}',
    'externalImport.openRemote': 'Abrir issue remota', 'externalImport.ignore': 'Ignorar', 'externalImport.ignoreConfirm': 'Ignorar a issue remota #{number}? Ela não aparecerá em buscas futuras.', 'externalImport.ignored': 'A issue remota #{number} foi ignorada.',
    'externalImport.edit': 'Editar e importar', 'externalImport.confirm': 'Confirmar importação', 'externalImport.importing': 'Importando…', 'externalImport.imported': 'A issue remota #{number} foi importada como issue local #{id}.',
  },
  ru: {
    'externalImport.title': 'Импорт внешних задач', 'externalImport.description': 'Получите открытые задачи по запросу, проверьте и измените их перед импортом в очередь проекта.', 'externalImport.fetch': 'Получить открытые задачи', 'externalImport.fetching': 'Получение…',
    'externalImport.configureFirst': 'Перед получением настройте источник задач GitHub или GitLab и токен API.', 'externalImport.configureAction': 'Открыть настройки проекта', 'externalImport.source': 'Текущий источник',
    'externalImport.idle': 'Удалённый запрос ещё не выполнялся. Когда будете готовы, выберите Получить открытые задачи.', 'externalImport.empty': 'Необработанных открытых задач не найдено.', 'externalImport.count': '{count, plural, one {# открытая задача} few {# открытые задачи} many {# открытых задач} other {# открытой задачи}}',
    'externalImport.author': 'Автор: {author}', 'externalImport.labels': 'Метки: {labels}', 'externalImport.created': 'Создана: {time}', 'externalImport.updated': 'Обновлена: {time}',
    'externalImport.openRemote': 'Открыть удалённую задачу', 'externalImport.ignore': 'Игнорировать', 'externalImport.ignoreConfirm': 'Игнорировать удалённую задачу № {number}? Она больше не появится при получении.', 'externalImport.ignored': 'Удалённая задача № {number} проигнорирована.',
    'externalImport.edit': 'Изменить и импортировать', 'externalImport.confirm': 'Подтвердить импорт', 'externalImport.importing': 'Импорт…', 'externalImport.imported': 'Удалённая задача № {number} импортирована как локальная задача № {id}.',
  },
};

export const externalImportMessages: Readonly<Record<SupportedLocale, Catalog>> = { en, ...translations };
