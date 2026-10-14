// Error reporting (Sentry, project tnt-backend). Imported first in server.js.
//
// On only in production, so local runs and the CI check never report. Set
// SENTRY_FORCE=true to send from anywhere (used to test the setup). The DSN
// only lets a client submit events, so it is not a secret.
import * as Sentry from '@sentry/node';

const DSN = process.env.SENTRY_DSN ||
    'https://5d9689dc44dba68e45fe6d6337c1f3dd@o4512256302710784.ingest.de.sentry.io/4512256449773648';

const enabled = process.env.NODE_ENV === 'production' || process.env.SENTRY_FORCE === 'true';

if (enabled) {
    Sentry.init({
        dsn: DSN,
        environment: process.env.NODE_ENV || 'development',
        // Errors only: performance tracing would eat the free plan's quota.
        tracesSampleRate: 0,
        sendDefaultPii: false,
    });
}

export default Sentry;
