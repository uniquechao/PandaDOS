import { shellMessages } from '../domains/shell';
import { actionMessages } from '../domains/actions';
import { commonUiMessages } from '../domains/common-ui';
import { statusMessages } from '../domains/status';
import { errorMessages } from '../domains/errors';
import { notifyMessages } from '../domains/notify';

export const enCatalog = {
  ...shellMessages.en,
  ...actionMessages.en,
  ...commonUiMessages.en,
  ...statusMessages.en,
  ...errorMessages.en,
  ...notifyMessages.en,
  'common.cancel': 'Cancel',
  'common.close': 'Close',
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.issueCount': '{count, plural, one {# issue} other {# issues}}',
  'locale.loadFailed': 'Could not load the selected language. English is being used.',
  'locale.languageAria': 'Language',
  'login.tagline': 'Your pocket engineering command center',
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
