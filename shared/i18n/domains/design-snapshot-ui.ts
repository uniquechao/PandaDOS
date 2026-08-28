import type { SupportedLocale } from '../locales';

export const designSnapshotUiMessages: Readonly<Record<SupportedLocale, Record<'design.publishSnapshotIncomplete', string>>> = {
  en: { 'design.publishSnapshotIncomplete': 'The immutable publication preview is incomplete. Refresh after the design service is updated.' },
  'zh-Hans': { 'design.publishSnapshotIncomplete': '不可变发布预览不完整。请在设计服务更新后刷新。' },
  'zh-Hant': { 'design.publishSnapshotIncomplete': '不可變發佈預覽不完整。請在設計服務更新後重新整理。' },
  ja: { 'design.publishSnapshotIncomplete': '不変の公開プレビューが不完全です。設計サービスの更新後に再読み込みしてください。' },
  ko: { 'design.publishSnapshotIncomplete': '변경 불가능한 게시 미리보기가 불완전합니다. 디자인 서비스 업데이트 후 새로고침하세요.' },
  es: { 'design.publishSnapshotIncomplete': 'La vista previa inmutable está incompleta. Actualiza después de renovar el servicio de diseño.' },
  fr: { 'design.publishSnapshotIncomplete': 'L’aperçu de publication immuable est incomplet. Actualisez après la mise à jour du service de conception.' },
  de: { 'design.publishSnapshotIncomplete': 'Die unveränderliche Veröffentlichungsvorschau ist unvollständig. Aktualisieren Sie nach dem Update des Designdienstes.' },
  'pt-BR': { 'design.publishSnapshotIncomplete': 'A prévia imutável da publicação está incompleta. Atualize após a atualização do serviço de design.' },
  ru: { 'design.publishSnapshotIncomplete': 'Неизменяемое превью публикации неполно. Обновите страницу после обновления сервиса дизайна.' },
};
