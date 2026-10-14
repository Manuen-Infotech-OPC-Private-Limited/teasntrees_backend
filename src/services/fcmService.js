import admin from '../config/firebase.js';
import logger from '../config/logger.js';
import { isDeadTokenError, forgetDeadTokens, deadTokensIn } from './deadTokens.js';

/**
 * FCM Service
 * Wrapper for Firebase Admin Messaging for centralized notification management.
 */
export const fcmService = {
    /**
     * Send Push Notification to a specific device token
     * @param {string} token - FCM Device Token
     * @param {string} title - Notification Title
     * @param {string} body - Notification Body
     * @param {Object} data - Optional data payload
     */
    sendPush: async (token, title, body, data = {}) => {
        try {
            if (!token) {
                logger.warn('FCM: No token provided for notification');
                return null;
            }

            const message = {
                notification: { title, body },
                data: {
                    ...data,
                    click_action: 'FLUTTER_NOTIFICATION_CLICK',
                },
                token: token
            };

            const response = await admin.messaging().send(message);
            logger.info(`FCM: Successfully sent message to token: ${token}. Response: ${response}`);
            return response;
        } catch (error) {
            if (isDeadTokenError(error)) {
                await forgetDeadTokens([token]);
            } else {
                logger.error(`FCM: Error sending message: ${error.message}`);
            }
            return null;
        }
    },

    /**
     * Send Push Notification to multiple device tokens
     * @param {string[]} tokens - Array of FCM Device Tokens
     * @param {string} title - Notification Title
     * @param {string} body - Notification Body
     * @param {Object} data - Optional data payload
     */
    sendMulticast: async (tokens, title, body, data = {}) => {
        try {
            const validTokens = tokens.filter(t => !!t);
            if (validTokens.length === 0) return null;

            const message = {
                notification: { title, body },
                data: data,
                tokens: validTokens,
            };

            const response = await admin.messaging().sendEachForMulticast(message);
            logger.info(`FCM: Multicast sent. Success: ${response.successCount}, Failure: ${response.failureCount}`);
            await forgetDeadTokens(deadTokensIn(response, validTokens));
            return response;
        } catch (error) {
            logger.error(`FCM: Multicast Error: ${error.message}`);
            return null;
        }
    }
};
