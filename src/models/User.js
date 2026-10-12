// User model

import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        trim: true,
        default: null
    },

    email: {
        type: String,
        sparse: true,
        lowercase: true,
        trim: true,
        default: null
    },

    mobile: {
        type: String,
        sparse: true, // Allow multiple null values without violating unique constraint
        trim: true,
        // default: null,
        validate: {
            validator: function (v) {
                // Allow null (for Google users who haven't provided phone yet)
                if (!v) return true;
                // Validates Indian mobile format (10 digits)
                return /^[0-9]{10}$/.test(v);
            },
            message: props => `${props.value} is not a valid 10-digit mobile number!`
        }
    },

    address: {
        type: String,
        trim: true,
        default: null
    },

    location: {
        type: {
            type: String,
            enum: ['Point'],
            // default: 'Point'
        },
        coordinates: {
            type: [Number],
            default: undefined
        }
    },

    preferences: {
        activeBrand: {
            type: String,
            enum: ['teasntrees', 'littleh'],
            default: 'teasntrees'
        }
    },

    role: {
        type: String,
        enum: ['admin', 'customer', 'rider', 'manager'],
        required: true
    },
    brand: {
        type: String,
        enum: ['teasntrees', 'littleh'],
        required: function () {
            return ['admin', 'manager'].includes(this.role);
        }
    },

    isProfileComplete: {
        type: Boolean,
        default: false
    },

    isActive: {
        type: Boolean,
        default: true
    },

    // Account lockout fields
    loginAttempts: {
        type: Number,
        default: 0
    },
    lockUntil: {
        type: Date
    },
    isLocked: {
        type: Boolean,
        default: false
    },

    // Approval status (for manager/rider)
    isApproved: {
        type: Boolean,
        default: null  // null = not applicable (customer/admin), true/false for manager/rider
    },
    fcmToken: {
        type: String,
        default: null
    },
    /// The rider's login PIN, stored as a bcrypt hash and never returned to a
    /// client. It used to default to a random PLAINTEXT value for every user —
    /// which also got reused as the delivery OTP. Delivery codes are now minted
    /// per delivery, and customers authenticate through Firebase, so nothing
    /// needs a PIN unless it is explicitly set (registerRider hashes one).
    verificationPin: {
        type: String,
        default: null,
        select: false
    },

    // Set when the person deleted their own account in the app: the record is
    // deactivated and anonymised, not removed (services/accountDeletionService.js).
    deletedAt: {
        type: Date,
        default: null
    },

    // For Riders: Linked Manager
    managerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User', // Can ref Manager (which is a User)
        default: null,
        index: true
    }

}, {
    timestamps: true,
    discriminatorKey: 'kind'
});

userSchema.index({ location: '2dsphere' });
userSchema.index({ mobile: 1, role: 1 }, { unique: true, sparse: true });
userSchema.index({ email: 1, role: 1 }, { unique: true, sparse: true });

userSchema.methods.checkProfileComplete = function () {
    return !!(this.name && this.email && this.address && this.role);
};

export default mongoose.model('User', userSchema);