import mongoose from 'mongoose';

const purchaseItemSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    category: {
        type: String,
        trim: true
    },
    quantity: {
        type: Number,
        required: true,
        min: 0.01
    },
    unit: {
        type: String,
        enum: ['kg', 'g', 'litre', 'ml', 'packet', 'box', 'can', 'piece', 'bundle'],
        default: 'kg'
    },
    unitPrice: {
        type: Number,
        required: true,
        min: 0
    },
    taxRate: {
        type: Number,
        default: 0,
        min: 0,
        max: 100
    },
    taxAmount: {
        type: Number,
        default: 0,
        min: 0
    },
    totalPrice: {
        type: Number,
        required: true,
        min: 0
    }
}, { _id: true });

const purchasePaymentSchema = new mongoose.Schema({
    amount: {
        type: Number,
        required: true,
        min: 0.01
    },
    paidAt: {
        type: Date,
        default: Date.now
    },
    method: {
        type: String,
        enum: ['bank_transfer', 'upi', 'cash', 'cheque', 'credit'],
        default: 'bank_transfer'
    },
    transactionRef: {
        type: String,
        trim: true
    },
    notes: {
        type: String,
        trim: true
    }
}, { _id: true });

const purchaseSchema = new mongoose.Schema({
    purchaseNumber: {
        type: String,
        unique: true,
        required: true,
        index: true
    },
    brand: {
        type: String,
        enum: ['teasntrees', 'littleh'],
        default: 'teasntrees',
        required: true,
        index: true
    },
    vendor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Vendor',
        required: [true, 'Vendor reference is required'],
        index: true
    },
    invoiceNumber: {
        type: String,
        trim: true,
        required: [true, 'Invoice/Bill number is required']
    },
    invoiceDate: {
        type: Date,
        default: Date.now,
        required: true,
        index: true
    },
    deliveryDate: {
        type: Date
    },
    items: {
        type: [purchaseItemSchema],
        validate: {
            validator: (v) => Array.isArray(v) && v.length > 0,
            message: 'Purchase must have at least one line item.'
        }
    },
    subtotal: {
        type: Number,
        required: true,
        min: 0
    },
    taxAmount: {
        type: Number,
        default: 0,
        min: 0
    },
    totalAmount: {
        type: Number,
        required: true,
        min: 0
    },
    paidAmount: {
        type: Number,
        default: 0,
        min: 0
    },
    balanceAmount: {
        type: Number,
        default: 0,
        min: 0
    },
    paymentStatus: {
        type: String,
        enum: ['paid', 'partial', 'pending'],
        default: 'pending',
        index: true
    },
    paymentMethod: {
        type: String,
        enum: ['bank_transfer', 'upi', 'cash', 'cheque', 'credit'],
        default: 'bank_transfer'
    },
    payments: [purchasePaymentSchema],
    status: {
        type: String,
        enum: ['received', 'ordered', 'cancelled'],
        default: 'received',
        index: true
    },
    invoiceDocument: {
        type: String,
        trim: true
    },
    notes: {
        type: String,
        trim: true
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Calculate balance and paymentStatus before save
purchaseSchema.pre('save', function () {
    if (this.totalAmount != null) {
        this.balanceAmount = Math.max(0, Number((this.totalAmount - (this.paidAmount || 0)).toFixed(2)));

        if (this.balanceAmount <= 0 && this.totalAmount > 0) {
            this.paymentStatus = 'paid';
        } else if (this.paidAmount > 0 && this.balanceAmount > 0) {
            this.paymentStatus = 'partial';
        } else {
            this.paymentStatus = 'pending';
        }
    }
});

purchaseSchema.index({ brand: 1, invoiceDate: -1 });
purchaseSchema.index({ brand: 1, vendor: 1 });
purchaseSchema.index({ brand: 1, paymentStatus: 1 });

export default mongoose.model('Purchase', purchaseSchema);

