import User from '../models/User.js';
import logger from '../config/logger.js';

// Firebase's answer for a token that will never work again: the app was
// uninstalled, or the device re-registered under a new token. Anything else
// (a bad payload, a quota error) says nothing about the token.
const DEAD_TOKEN_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
]);

export const isDeadTokenError = (error) => DEAD_TOKEN_CODES.has(error?.code);

/**
 * Stop sending to a token Firebase has rejected for good. Without this the
 * hourly nudge worker retried the same dead tokens forever and filled the
 * error log with "NotRegistered" (about 1,900 lines by October 2026). The app
 * registers a fresh token on its next sign-in, so nothing is lost.
 */
export const forgetDeadTokens = async (tokens) => {
    const dead = [...new Set(tokens.filter(Boolean))];
    if (dead.length === 0) return;
    try {
        const { modifiedCount } = await User.updateMany(
            { fcmToken: { $in: dead } },
            { $set: { fcmToken: null } }
        );
        logger.info(`FCM: forgot ${dead.length} dead token(s) on ${modifiedCount} account(s)`);
    } catch (error) {
        logger.warn(`FCM: could not forget dead tokens: ${error.message}`);
    }
};

/** Dead tokens out of a sendEachForMulticast response, in token order. */
export const deadTokensIn = (response, tokens) =>
    (response?.responses || [])
        .map((r, i) => (!r.success && isDeadTokenError(r.error) ? tokens[i] : null))
        .filter(Boolean);
