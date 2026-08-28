import type { SupportedLocale } from '../locales';

const en = {
  'design.readinessSnapshot': 'Readiness at confirmation',
  'design.readinessOverrideActive': 'override active',
  'design.readinessOverrideInactive': 'no override',
  'design.topologicalOrder': 'Execution order',
  'design.nonGoals': 'Non-goals',
  'design.inputs': 'Inputs',
  'design.outputs': 'Outputs',
  'design.implementationNotes': 'Implementation notes',
  'design.complexity': 'Complexity',
  'design.complexity.low': 'Low',
  'design.complexity.medium': 'Medium',
  'design.complexity.high': 'High',
  'design.complexityRationale': 'Complexity rationale',
  'design.completionInstructions': 'Completion instructions',
  'design.bodyDigest': 'Issue body digest',
} as const;

type Key = keyof typeof en;
const l = (messages: Record<Key, string>): Record<Key, string> => messages;

export const designConfirmationUiMessages: Readonly<Record<SupportedLocale, Record<Key, string>>> = {
  en,
  'zh-Hans': l({
    'design.readinessSnapshot': '确认时可执行度', 'design.readinessOverrideActive': '已启用人工覆盖', 'design.readinessOverrideInactive': '未启用覆盖', 'design.topologicalOrder': '执行顺序',
    'design.nonGoals': '非目标', 'design.inputs': '输入', 'design.outputs': '输出', 'design.implementationNotes': '实现说明', 'design.complexity': '复杂度',
    'design.complexity.low': '低', 'design.complexity.medium': '中', 'design.complexity.high': '高', 'design.complexityRationale': '复杂度依据',
    'design.completionInstructions': '完成说明', 'design.bodyDigest': 'Issue 正文摘要',
  }),
  'zh-Hant': l({
    'design.readinessSnapshot': '確認時可執行度', 'design.readinessOverrideActive': '已啟用人工覆寫', 'design.readinessOverrideInactive': '未啟用覆寫', 'design.topologicalOrder': '執行順序',
    'design.nonGoals': '非目標', 'design.inputs': '輸入', 'design.outputs': '輸出', 'design.implementationNotes': '實作說明', 'design.complexity': '複雜度',
    'design.complexity.low': '低', 'design.complexity.medium': '中', 'design.complexity.high': '高', 'design.complexityRationale': '複雜度依據',
    'design.completionInstructions': '完成說明', 'design.bodyDigest': 'Issue 正文摘要',
  }),
  ja: l({
    'design.readinessSnapshot': '確認時の実行可能度', 'design.readinessOverrideActive': '上書き有効', 'design.readinessOverrideInactive': '上書きなし', 'design.topologicalOrder': '実行順序',
    'design.nonGoals': '対象外', 'design.inputs': '入力', 'design.outputs': '出力', 'design.implementationNotes': '実装メモ', 'design.complexity': '複雑度',
    'design.complexity.low': '低', 'design.complexity.medium': '中', 'design.complexity.high': '高', 'design.complexityRationale': '複雑度の根拠',
    'design.completionInstructions': '完了手順', 'design.bodyDigest': 'Issue 本文ダイジェスト',
  }),
  ko: l({
    'design.readinessSnapshot': '확인 시 실행 준비도', 'design.readinessOverrideActive': '재정의 활성', 'design.readinessOverrideInactive': '재정의 없음', 'design.topologicalOrder': '실행 순서',
    'design.nonGoals': '비목표', 'design.inputs': '입력', 'design.outputs': '출력', 'design.implementationNotes': '구현 메모', 'design.complexity': '복잡도',
    'design.complexity.low': '낮음', 'design.complexity.medium': '중간', 'design.complexity.high': '높음', 'design.complexityRationale': '복잡도 근거',
    'design.completionInstructions': '완료 지침', 'design.bodyDigest': 'Issue 본문 다이제스트',
  }),
  es: l({
    'design.readinessSnapshot': 'Preparación al confirmar', 'design.readinessOverrideActive': 'excepción activa', 'design.readinessOverrideInactive': 'sin excepción', 'design.topologicalOrder': 'Orden de ejecución',
    'design.nonGoals': 'Fuera de alcance', 'design.inputs': 'Entradas', 'design.outputs': 'Salidas', 'design.implementationNotes': 'Notas de implementación', 'design.complexity': 'Complejidad',
    'design.complexity.low': 'Baja', 'design.complexity.medium': 'Media', 'design.complexity.high': 'Alta', 'design.complexityRationale': 'Justificación de complejidad',
    'design.completionInstructions': 'Instrucciones de finalización', 'design.bodyDigest': 'Resumen del cuerpo de la issue',
  }),
  fr: l({
    'design.readinessSnapshot': 'Préparation à la confirmation', 'design.readinessOverrideActive': 'dérogation active', 'design.readinessOverrideInactive': 'sans dérogation', 'design.topologicalOrder': 'Ordre d’exécution',
    'design.nonGoals': 'Hors objectifs', 'design.inputs': 'Entrées', 'design.outputs': 'Sorties', 'design.implementationNotes': 'Notes d’implémentation', 'design.complexity': 'Complexité',
    'design.complexity.low': 'Faible', 'design.complexity.medium': 'Moyenne', 'design.complexity.high': 'Élevée', 'design.complexityRationale': 'Justification de la complexité',
    'design.completionInstructions': 'Instructions d’achèvement', 'design.bodyDigest': 'Empreinte du corps de l’issue',
  }),
  de: l({
    'design.readinessSnapshot': 'Bereitschaft bei Bestätigung', 'design.readinessOverrideActive': 'Übersteuerung aktiv', 'design.readinessOverrideInactive': 'keine Übersteuerung', 'design.topologicalOrder': 'Ausführungsreihenfolge',
    'design.nonGoals': 'Nicht-Ziele', 'design.inputs': 'Eingaben', 'design.outputs': 'Ausgaben', 'design.implementationNotes': 'Implementierungshinweise', 'design.complexity': 'Komplexität',
    'design.complexity.low': 'Niedrig', 'design.complexity.medium': 'Mittel', 'design.complexity.high': 'Hoch', 'design.complexityRationale': 'Komplexitätsbegründung',
    'design.completionInstructions': 'Abschlussanweisungen', 'design.bodyDigest': 'Prüfsumme des Issue-Texts',
  }),
  'pt-BR': l({
    'design.readinessSnapshot': 'Prontidão na confirmação', 'design.readinessOverrideActive': 'substituição ativa', 'design.readinessOverrideInactive': 'sem substituição', 'design.topologicalOrder': 'Ordem de execução',
    'design.nonGoals': 'Não objetivos', 'design.inputs': 'Entradas', 'design.outputs': 'Saídas', 'design.implementationNotes': 'Notas de implementação', 'design.complexity': 'Complexidade',
    'design.complexity.low': 'Baixa', 'design.complexity.medium': 'Média', 'design.complexity.high': 'Alta', 'design.complexityRationale': 'Justificativa da complexidade',
    'design.completionInstructions': 'Instruções de conclusão', 'design.bodyDigest': 'Resumo do corpo da issue',
  }),
  ru: l({
    'design.readinessSnapshot': 'Готовность на момент подтверждения', 'design.readinessOverrideActive': 'переопределение включено', 'design.readinessOverrideInactive': 'без переопределения', 'design.topologicalOrder': 'Порядок выполнения',
    'design.nonGoals': 'Не входит в цели', 'design.inputs': 'Входы', 'design.outputs': 'Результаты', 'design.implementationNotes': 'Примечания по реализации', 'design.complexity': 'Сложность',
    'design.complexity.low': 'Низкая', 'design.complexity.medium': 'Средняя', 'design.complexity.high': 'Высокая', 'design.complexityRationale': 'Обоснование сложности',
    'design.completionInstructions': 'Инструкции по завершению', 'design.bodyDigest': 'Хэш тела задачи',
  }),
};
