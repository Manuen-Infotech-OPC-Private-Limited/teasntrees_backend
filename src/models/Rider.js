import mongoose from 'mongoose';
import User from './User.js';

const riderSchema = new mongoose.Schema({
    // Human-readable rider id shown in the app (e.g. TNT-0042). The raw Mongo
    // _id was leaking onto the ID card and dashboard. Assigned once on create.
    readableId: {
        type: String,
        unique: true,
        sparse: true, // existing riders may not have one until backfilled
    },

    // Vehicle Details
    vehicleType: {
        type: String,
        enum: ['bike', 'scooter', 'bicycle', 'electric_scooter'],
        required: true
    },
    vehicleNumber: {
        type: String,
        required: true,
        trim: true
    },
    vehicleModel: {
        type: String,
        trim: true
    },

    // Legal Documents (URLs to images/PDFs)
    licenseNumber: { type: String },
    licenseExpiryDate: { type: Date },
    licensePhoto: { type: String }, // URL

    aadharNumber: { type: String },
    aadharPhoto: { type: String }, // URL

    panNumber: { type: String },
    panPhoto: { type: String }, // URL

    // Bank Details (For Payouts)
    bankAccountNumber: { type: String },
    ifscCode: { type: String },
    accountHolderName: { type: String },

    // Emergency Contact
    emergencyContact: {
        name: String,
        mobile: String,
        relation: String
    },

    // Status & Availability
    isOnline: {
        type: Boolean,
        default: false
    },
    isOnDelivery: {
        type: Boolean,
        default: false
    },

    // Self-service PIN resets (POST /rider/auth/reset-pin). Kept on the rider
    // so the admin panel can show "PIN reset on <date>" without a separate
    // lookup — the live socket event alone is missed by anyone not online.
    pinResetAt: { type: Date, default: null },
    pinResetCount: { type: Number, default: 0 },
    lockUntil: {
        type: Date,
        default: null,
        index: true
    },
    currentLocation: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point'
        },
        coordinates: {
            type: [Number],
            default: [0, 0] // [longitude, latitude]
        },
        lastUpdated: { type: Date }
    },

    // Performance Stats
    totalDeliveries: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    pendingEarnings: { type: Number, default: 0 },
    averageRating: { type: Number, default: 0 },
    ratingsCount: { type: Number, default: 0 },

    performanceMetrics: {
        acceptanceRate: { type: Number, default: 100 },
        completionRate: { type: Number, default: 100 },
        averageRating: { type: Number, default: 0 },
        totalReviews: { type: Number, default: 0 }
    },

    // Operational Preferences
    preferredZones: [String],
    maxDeliveriesPerDay: { type: Number, default: 30 }

}, {
    discriminatorKey: 'kind',
    toJSON: { getters: true },
    toObject: { getters: true }
});

// Index for geospatial queries (finding nearest rider)
riderSchema.index({ currentLocation: '2dsphere' });
riderSchema.index({ isOnline: 1, isOnDelivery: 1, isApproved: 1 });

// Assign a sequential human id (TNT-0042) on first save. Mirrors the Order
// number generation, using the shared Counter collection.
riderSchema.pre('save', async function () {
    if (this.readableId) return;

    const Counter = mongoose.model('Counter');
    const counter = await Counter.findOneAndUpdate(
        { name: 'rider' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );

    this.readableId = `TNT-${String(counter.seq).padStart(4, '0')}`;
});

const Rider = User.discriminator('Rider', riderSchema);

export default Rider;
