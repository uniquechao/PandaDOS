import { feishuChatMessages } from '../domains/feishu-chat';
import { feishuLoginMessages } from '../domains/feishu-login';
import { shellMessages } from '../domains/shell';
import { actionMessages } from '../domains/actions';
import { commonUiMessages } from '../domains/common-ui';
import { statusMessages } from '../domains/status';
import { errorMessages } from '../domains/errors';
import { notifyMessages } from '../domains/notify';
import { projectSettingsMessages } from '../domains/project-settings';
import { externalImportMessages } from '../domains/external-import';
import { designWorkbenchMessages } from '../domains/design-workbench';
import { designWorkbenchAdvancedMessages } from '../domains/design-workbench-advanced';
import { designAssetsUiMessages } from '../domains/design-assets-ui';
import { designFinalUiMessages } from '../domains/design-final-ui';
import { designReviewFixMessages } from '../domains/design-review-fixes';
import { designSnapshotUiMessages } from '../domains/design-snapshot-ui';
import { designConfirmationUiMessages } from '../domains/design-confirmation-ui';
import { workflowMessages } from '../domains/workflows';

export const enCatalog = {
  ...feishuChatMessages["en"],
  ...feishuLoginMessages["en"],
  ...shellMessages.en,
  ...actionMessages.en,
  ...commonUiMessages.en,
  ...statusMessages.en,
  ...errorMessages.en,
  ...notifyMessages.en,
  ...projectSettingsMessages.en,
  ...externalImportMessages.en,
  ...designWorkbenchMessages.en,
  ...designWorkbenchAdvancedMessages.en,
  ...designAssetsUiMessages.en,
  ...designFinalUiMessages.en,
  ...designReviewFixMessages.en,
  ...designSnapshotUiMessages.en,
  ...designConfirmationUiMessages.en,
  ...workflowMessages.en,
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.issueCount': '{count, plural, one {# issue} other {# issues}}',
  'locale.loadFailed': 'Could not load the selected language. English is being used.',
  'locale.languageAria': 'Language',
  'login.username': 'Username',
  'login.token': 'Token',
  'login.signingIn': 'Signing in…',
  'login.signIn': 'Sign in',
  'login.feishuSignIn': 'Sign in with Feishu',
  'login.failed': 'Sign-in failed',
  'settings.languageRegion': 'Language & region',
  'settings.language': 'Language',
  'settings.timezone': 'Timezone',
  'settings.timezoneAutomatic': 'Automatic ({zone})',
  'settings.timezoneAutoButton': 'Automatic',
  'settings.localePreview': 'Preview',
  'settings.preferenceSaveFailed': 'Could not save the language and region settings.',
  'date.localTime': 'local time',
  'date.today': 'today',
  'date.tomorrow': 'tomorrow',
} as const;
