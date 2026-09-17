import type { SupportedLocale } from '../locales';

const en = {
  "feishuChat.bindFirst": "Sign in to PandaDOS with Feishu, or bind your Feishu account in settings, then send your message again.",
  "feishuChat.noProjects": "You have no accessible active projects. Ask a project owner to add you as a member.",
  "feishuChat.projects": "Your projects:\n{projects}\nSend #ID or #exact project name to select a project, optionally followed by a question. Later messages use the selected project. Send projects to list projects.",
  "feishuChat.ambiguous": "Several projects have that name. Select one by #ID:\n{projects}",
  "feishuChat.unavailable": "That project is unavailable or you do not have access. Send projects to see your projects.",
  "feishuChat.selected": "Selected project #{id}: {name}. Send your question.",
  "feishuChat.failed": "Could not answer your question. Please try again later.",
  "feishuChat.answer": "Project #{id}: {name}\n{answer}"
} as const;

export const feishuChatMessages: Record<SupportedLocale, Record<keyof typeof en, string>> = {
  en,
  "zh-Hans": {
  "feishuChat.bindFirst": "请先使用飞书登录 PandaDOS，或在设置中绑定飞书账号，再重新发送消息。",
  "feishuChat.noProjects": "你目前没有可访问的活跃项目，请联系项目属主将你加入成员。",
  "feishuChat.projects": "你的项目：\n{projects}\n发送 #编号 或 #完整项目名 选择项目，后面可接问题。后续消息沿用所选项目；发送“项目”查看列表。",
  "feishuChat.ambiguous": "有多个同名项目，请用 #编号 选择：\n{projects}",
  "feishuChat.unavailable": "项目不存在或你无权访问。发送“项目”查看可访问列表。",
  "feishuChat.selected": "已选择项目 #{id}：{name}。请发送问题。",
  "feishuChat.failed": "暂时无法回答，请稍后重试。",
  "feishuChat.answer": "项目 #{id}：{name}\n{answer}"
},
  "zh-Hant": {
  "feishuChat.bindFirst": "請先使用飛書登入 PandaDOS，或在設定中綁定飛書帳號，再重新傳送訊息。",
  "feishuChat.noProjects": "你目前沒有可存取的使用中專案，請聯絡專案擁有者將你加入成員。",
  "feishuChat.projects": "你的專案：\n{projects}\n傳送 #編號 或 #完整專案名稱 選擇專案，後面可接問題。後續訊息沿用所選專案；傳送 projects 查看清單。",
  "feishuChat.ambiguous": "有多個同名專案，請用 #編號 選擇：\n{projects}",
  "feishuChat.unavailable": "專案不存在或你無權存取。傳送 projects 查看可存取清單。",
  "feishuChat.selected": "已選擇專案 #{id}：{name}。請傳送問題。",
  "feishuChat.failed": "暫時無法回答，請稍後重試。",
  "feishuChat.answer": "專案 #{id}：{name}\n{answer}"
},
  "ja": {
  "feishuChat.bindFirst": "Feishu で PandaDOS にログインするか、設定で Feishu アカウントを連携してから、メッセージを再送してください。",
  "feishuChat.noProjects": "アクセス可能な有効なプロジェクトがありません。所有者にメンバーへの追加を依頼してください。",
  "feishuChat.projects": "利用可能なプロジェクト：\n{projects}\n#ID または #正式なプロジェクト名 で選択し、続けて質問を入力できます。以降のメッセージは選択中のプロジェクトに送られます。projects で一覧を表示します。",
  "feishuChat.ambiguous": "同名のプロジェクトが複数あります。#ID で選択してください：\n{projects}",
  "feishuChat.unavailable": "プロジェクトが存在しないか、アクセス権がありません。projects で一覧を表示してください。",
  "feishuChat.selected": "プロジェクト #{id}：{name} を選択しました。質問を送信してください。",
  "feishuChat.failed": "回答できませんでした。後でもう一度お試しください。",
  "feishuChat.answer": "プロジェクト #{id}：{name}\n{answer}"
},
  "ko": {
  "feishuChat.bindFirst": "Feishu로 PandaDOS에 로그인하거나 설정에서 Feishu 계정을 연결한 후 메시지를 다시 보내세요.",
  "feishuChat.noProjects": "접근 가능한 활성 프로젝트가 없습니다. 프로젝트 소유자에게 멤버 추가를 요청하세요.",
  "feishuChat.projects": "내 프로젝트:\n{projects}\n#ID 또는 #정확한 프로젝트 이름 으로 선택하고 이어서 질문할 수 있습니다. 이후 메시지는 선택한 프로젝트를 사용합니다. projects로 목록을 확인하세요.",
  "feishuChat.ambiguous": "같은 이름의 프로젝트가 여러 개입니다. #ID로 선택하세요:\n{projects}",
  "feishuChat.unavailable": "프로젝트를 사용할 수 없거나 접근 권한이 없습니다. projects로 목록을 확인하세요.",
  "feishuChat.selected": "프로젝트 #{id}: {name} 선택됨. 질문을 보내세요.",
  "feishuChat.failed": "답변할 수 없습니다. 나중에 다시 시도하세요.",
  "feishuChat.answer": "프로젝트 #{id}: {name}\n{answer}"
},
  "es": {
  "feishuChat.bindFirst": "Inicia sesión en PandaDOS con Feishu o vincula tu cuenta de Feishu en los ajustes y vuelve a enviar el mensaje.",
  "feishuChat.noProjects": "No tienes proyectos activos accesibles. Pide al propietario que te añada como miembro.",
  "feishuChat.projects": "Tus proyectos:\n{projects}\nEnvía #ID o #nombre exacto del proyecto para seleccionarlo, seguido de una pregunta si quieres. Los siguientes mensajes usan el proyecto seleccionado. Envía projects para ver la lista.",
  "feishuChat.ambiguous": "Varios proyectos tienen ese nombre. Selecciona uno con #ID:\n{projects}",
  "feishuChat.unavailable": "El proyecto no está disponible o no tienes acceso. Envía projects para ver tus proyectos.",
  "feishuChat.selected": "Proyecto #{id}: {name} seleccionado. Envía tu pregunta.",
  "feishuChat.failed": "No se pudo responder. Inténtalo más tarde.",
  "feishuChat.answer": "Proyecto #{id}: {name}\n{answer}"
},
  "fr": {
  "feishuChat.bindFirst": "Connectez-vous à PandaDOS avec Feishu ou associez votre compte Feishu dans les paramètres, puis renvoyez votre message.",
  "feishuChat.noProjects": "Vous ne disposez d’aucun projet actif accessible. Demandez au propriétaire de vous ajouter comme membre.",
  "feishuChat.projects": "Vos projets :\n{projects}\nEnvoyez #ID ou #nom exact du projet pour le sélectionner, puis une question si vous le souhaitez. Les messages suivants utilisent ce projet. Envoyez projects pour afficher la liste.",
  "feishuChat.ambiguous": "Plusieurs projets portent ce nom. Sélectionnez-en un avec #ID :\n{projects}",
  "feishuChat.unavailable": "Ce projet est indisponible ou vous n’y avez pas accès. Envoyez projects pour afficher vos projets.",
  "feishuChat.selected": "Projet #{id} : {name} sélectionné. Envoyez votre question.",
  "feishuChat.failed": "Impossible de répondre. Réessayez plus tard.",
  "feishuChat.answer": "Projet #{id} : {name}\n{answer}"
},
  "de": {
  "feishuChat.bindFirst": "Melde dich mit Feishu bei PandaDOS an oder verknüpfe dein Feishu-Konto in den Einstellungen und sende die Nachricht erneut.",
  "feishuChat.noProjects": "Du hast keine zugänglichen aktiven Projekte. Bitte einen Projekteigentümer, dich als Mitglied hinzuzufügen.",
  "feishuChat.projects": "Deine Projekte:\n{projects}\nSende #ID oder #exakter Projektname zur Auswahl, optional gefolgt von einer Frage. Weitere Nachrichten verwenden das ausgewählte Projekt. Sende projects für die Liste.",
  "feishuChat.ambiguous": "Mehrere Projekte haben diesen Namen. Wähle eines per #ID:\n{projects}",
  "feishuChat.unavailable": "Das Projekt ist nicht verfügbar oder du hast keinen Zugriff. Sende projects für deine Projektliste.",
  "feishuChat.selected": "Projekt #{id}: {name} ausgewählt. Sende deine Frage.",
  "feishuChat.failed": "Die Frage konnte nicht beantwortet werden. Versuche es später erneut.",
  "feishuChat.answer": "Projekt #{id}: {name}\n{answer}"
},
  "pt-BR": {
  "feishuChat.bindFirst": "Entre no PandaDOS com o Feishu ou vincule sua conta do Feishu nas configurações e envie a mensagem novamente.",
  "feishuChat.noProjects": "Você não tem projetos ativos acessíveis. Peça ao proprietário para adicionar você como membro.",
  "feishuChat.projects": "Seus projetos:\n{projects}\nEnvie #ID ou #nome exato do projeto para selecionar, seguido de uma pergunta se quiser. As próximas mensagens usam o projeto selecionado. Envie projects para ver a lista.",
  "feishuChat.ambiguous": "Vários projetos têm esse nome. Selecione um por #ID:\n{projects}",
  "feishuChat.unavailable": "O projeto está indisponível ou você não tem acesso. Envie projects para ver seus projetos.",
  "feishuChat.selected": "Projeto #{id}: {name} selecionado. Envie sua pergunta.",
  "feishuChat.failed": "Não foi possível responder. Tente novamente mais tarde.",
  "feishuChat.answer": "Projeto #{id}: {name}\n{answer}"
},
  "ru": {
  "feishuChat.bindFirst": "Войдите в PandaDOS через Feishu или привяжите аккаунт Feishu в настройках, затем отправьте сообщение снова.",
  "feishuChat.noProjects": "У вас нет доступных активных проектов. Попросите владельца добавить вас в участники.",
  "feishuChat.projects": "Ваши проекты:\n{projects}\nОтправьте #ID или #точное название проекта для выбора, при желании добавив вопрос. Следующие сообщения используют выбранный проект. Отправьте projects для просмотра списка.",
  "feishuChat.ambiguous": "Есть несколько проектов с таким названием. Выберите по #ID:\n{projects}",
  "feishuChat.unavailable": "Проект недоступен или у вас нет доступа. Отправьте projects для просмотра ваших проектов.",
  "feishuChat.selected": "Выбран проект #{id}: {name}. Отправьте вопрос.",
  "feishuChat.failed": "Не удалось ответить. Попробуйте позже.",
  "feishuChat.answer": "Проект #{id}: {name}\n{answer}"
},
};
