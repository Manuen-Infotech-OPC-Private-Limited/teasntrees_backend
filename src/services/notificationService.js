import admin from '../config/firebase.js';
import logger from '../config/logger.js';
import { isDeadTokenError, forgetDeadTokens, deadTokensIn } from './deadTokens.js';

/**
 * Notification Service
 * Handles sending Push Notifications via FCM (Firebase Cloud Messaging)
 */
class NotificationService {
    /**
     * Send Push Notification to a single user
     * @param {Object} user - User document with fcmToken
     * @param {Object} notification - { title, body, data }
     */
    async sendPush(user, notification) {
        try {
            if (!user?.fcmToken) {
                logger.debug(`No FCM token for user: ${user?._id || 'unknown'}`);
                return false;
            }

            const message = {
                token: user.fcmToken,
                notification: {
                    title: notification.title,
                    body: notification.body
                },
                data: notification.data || {},
                android: {
                    priority: 'high',
                    notification: {
                        channelId: 'high_importance_channel',
                        clickAction: 'FLUTTER_NOTIFICATION_CLICK'
                    }
                },
                apns: {
                    payload: {
                        aps: {
                            contentAvailable: true,
                            badge: 1,
                            sound: 'default'
                        }
                    }
                }
            };

            const response = await admin.messaging().send(message);
            logger.info(`Push notification sent to ${user.name}: ${response}`);
            return true;
        } catch (error) {
            if (isDeadTokenError(error)) {
                await forgetDeadTokens([user.fcmToken]);
            } else {
                logger.error('Push Notification Error:', error.message);
            }
            return false;
        }
    }

    /**
     * Send to multiple users (Multicast)
     * @param {Array} users - Array of user documents
     * @param {Object} notification - { title, body, data }
     */
    async sendPushToMany(users, notification) {
        try {
            const tokens = users
                .map(u => u.fcmToken)
                .filter(t => !!t && typeof t === 'string' && t.length > 0);

            if (tokens.length === 0) return { successCount: 0, failureCount: 0 };

            const message = {
                tokens: tokens,
                notification: {
                    title: notification.title,
                    body: notification.body
                },
                data: notification.data || {},
                android: {
                    priority: 'high'
                }
            };

            const response = await admin.messaging().sendEachForMulticast(message);
            logger.info(`Batch push completed: ${response.successCount} success, ${response.failureCount} failure`);
            await forgetDeadTokens(deadTokensIn(response, tokens));
            return response;
        } catch (error) {
            logger.error('Batch Push Notification Error:', error.message);
            return null;
        }
    }

    /**
     * Notify all admins/managers
     */
    async notifyAdmins(adminModel, notification) {
        const admins = await adminModel.find({ 
            role: { $in: ['admin', 'manager'] },
            isActive: true 
        });
        return this.sendPushToMany(admins, notification);
    }
}

export const notificationService = new NotificationService();
