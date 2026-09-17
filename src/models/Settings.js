import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
    brand: {
        type: String,
        enum: ['teasntrees', 'littleh'],
        default: 'teasntrees',
        required: true
    },
    isStoreActive: {
        type: Boolean,
        default: true
    },
    deliveryCharge: {
        type: Number,
        default: 20
    },
    // freeDeliveryAbove: {
    //     type: Number,
    //     default: 500
    // },
    maxDeliveryDistance: {
        type: Number,
        default: 10
    },
    minimumOrderValue: {
        type: Number,
        default: 100
    },
    gstRate: {
        type: Number,
        default: 5
    },
    operatingHours: {
        monday: {
            open: { type: String, default: '09:00' },
            close: { type: String, default: '22:00' },
            isOpen: { type: Boolean, default: true }
        },
        tuesday: {
            open: { type: String, default: '09:00' },
            close: { type: String, default: '22:00' },
            isOpen: { type: Boolean, default: true }
        },
        wednesday: {
            open: { type: String, default: '09:00' },
            close: { type: String, default: '22:00' },
            isOpen: { type: Boolean, default: true }
        },
        thursday: {
            open: { type: String, default: '09:00' },
            close: { type: String, default: '22:00' },
            isOpen: { type: Boolean, default: true }
        },
        friday: {
            open: { type: String, default: '09:00' },
            close: { type: String, default: '22:00' },
            isOpen: { type: Boolean, default: true }
        },
        saturday: {
            open: { type: String, default: '09:00' },
            close: { type: String, default: '23:00' },
            isOpen: { type: Boolean, default: true }
        },
        sunday: {
            open: { type: String, default: '09:00' },
            close: { type: String, default: '23:00' },
            isOpen: { type: Boolean, default: true }
        }
    },
    serviceAreas: [{
        name: String,
        coordinates: [[Number]],
        deliveryCharge: Number
    }],
    riderBaseEarning: {
        type: Number,
        default: 20
    },
    distanceBonusPerKm: {
        type: Number,
        default: 5
    },
    contactPhone: String,
    contactEmail: String,
    address: String,
    socialMedia: {
        facebook: String,
        instagram: String,
        twitter: String
    },
    updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true
});

// Ensure only one settings document per brand
settingsSchema.index({ brand: 1 }, { unique: true });

export default mongoose.model('Settings', settingsSchema);