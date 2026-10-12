/**
 * Socket.io event names
 * Centralized event definitions for consistency
 */
export const SOCKET_EVENTS = {
    // Connection events
    CONNECTION: 'connection',
    DISCONNECT: 'disconnect',
    ERROR: 'error',

    // Order events
    ORDER_CREATED: 'order:created',
    ORDER_STATUS_UPDATED: 'order:status-updated',
    ORDER_CANCELLED: 'order:cancelled',
    ORDER_NEW: 'order:new', // For managers/admin

    // Category events
    CATEGORY_CREATED: 'category:created',
    CATEGORY_UPDATED: 'category:updated',
    CATEGORY_DELETED: 'category:deleted',

    // Product events
    PRODUCT_CREATED: 'product:created',
    PRODUCT_UPDATED: 'product:updated',
    PRODUCT_DELETED: 'product:deleted',

    // Delivery events
    DELIVERY_ASSIGNED: 'delivery:assigned',
    DELIVERY_ACCEPTED: 'delivery:accepted',
    DELIVERY_REJECTED: 'delivery:rejected',
    DELIVERY_PICKED_UP: 'delivery:picked-up',
    DELIVERY_IN_TRANSIT: 'delivery:in-transit',
    DELIVERY_DELIVERED: 'delivery:delivered',
    DELIVERY_STATUS_UPDATED: 'delivery:status-updated',

    // Rider events
    RIDER_LOCATION_UPDATE: 'rider:location-update',
    RIDER_AVAILABILITY_CHANGED: 'rider:availability-changed',
    RIDER_ONLINE: 'rider:online',
    RIDER_OFFLINE: 'rider:offline',
    RIDER_STATUS_UPDATED: 'rider:status-updated',
    RIDER_PIN_RESET: 'rider:pin-reset',

    // Rider assignment events (production-ready)
    RIDER_ASSIGNMENT_STARTED: 'rider:assignment-started',
    RIDER_ASSIGNED: 'rider:assigned',
    RIDER_ASSIGNMENT_FAILED: 'rider:assignment-failed',
    RIDER_ASSIGNMENT_TIMEOUT: 'rider:assignment-timeout',

    // User management events
    USER_ROLE_UPDATED: 'user:role-updated',
    USER_ACTIVATED: 'user:activated',
    USER_DEACTIVATED: 'user:deactivated',
    USER_REGISTERED: 'user:registered',
    USER_DELETED: 'user:deleted',
    USER_APPROVED: 'user:approved',
    USER_REJECTED: 'user:rejected',
    MANAGER_STATUS_UPDATED: 'manager:status-updated',

    // Notification events
    NOTIFICATION_NEW: 'notification:new',
    NOTIFICATION_READ: 'notification:read',

    // Settings events
    SETTINGS_UPDATED: 'settings:updated',
    DELIVERY_ZONES_UPDATED: 'delivery-zones:updated',

    // System events
    SYSTEM_MESSAGE: 'system:message',
    SYSTEM_DATA_UPDATED: 'system:data-updated',

    // Activity Log events
    ACTIVITY_LOG_NEW: 'activity-log:new',

    // Review events
    REVIEW_NEW: 'review:new',
    REVIEW_UPDATED: 'review:updated'
};

/**
 * Socket.io room names
 */
export const SOCKET_ROOMS = {
    // User-specific rooms
    user: (userId) => `user:${userId}`,

    // Role-based rooms
    role: (role) => `role:${role}`,

    // Brand-Role based rooms (Isolated)
    brandRole: (brand, role) => `brand:${brand}:role:${role}`,

    // Order-specific rooms
    order: (orderId) => `order:${orderId}`,

    // General rooms
    all: 'all'
};
