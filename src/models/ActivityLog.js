import mongoose from 'mongoose';

export const ACTIVITY_ACTIONS = [
    'create',
    'update',
    'delete',
    'activate',
    'deactivate',
    'login',
    'logout',
    'assign',
    'cancel',
    'approve',
    'reject',
    'accept',
    'update_status',
    'upload',
    'process',
    'complete_profile',
    'accept_delivery',
    'reject_delivery',
    'upload_proof',
    'toggle_availability',
    'update_payment',
    'payment',
    'cancel_order',
    'assign_rider',
    'firebase_login',
    'google_login'
];

export const ACTIVITY_RESOURCES = [
    'user',
    'product',
    'category',
    'order',
    'delivery',
    'settings',
    'auth',
    'image',
    'payout',
    'review',
    'rider',
    'manager',
    'customer',
    'purchase',
    'expense',
    'vendor',
    'report'
];

const activityLogSchema = new mongoose.Schema({
    admin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    brand: {
        type: String,
        enum: ['teasntrees', 'littleh']
    },
    action: {
        type: String,
        required: true,
        enum: ACTIVITY_ACTIONS
    },
    resource: {
        type: String,
        required: true,
        enum: ACTIVITY_RESOURCES
    },
    resourceId: {
        type: mongoose.Schema.Types.ObjectId
    },
    details: {
        type: Object,
        default: {}
    },
    ipAddress: {
        type: String
    },
    userAgent: {
        type: String
    },
    success: {
        type: Boolean,
        default: true
    },
    errorMessage: {
        type: String
    }
}, {
    timestamps: true
});

// Indexes for efficient queries
activityLogSchema.index({ admin: 1, createdAt: -1 });
activityLogSchema.index({ resource: 1, action: 1 });
activityLogSchema.index({ createdAt: -1 });

export default mongoose.model('ActivityLog', activityLogSchema);
