import mongoose from 'mongoose';

const expenseSchema = new mongoose.Schema({
    expenseNumber: {
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
    title: {
        type: String,
        required: [true, 'Expense title is required'],
        trim: true
    },
    category: {
        type: String,
        enum: [
            'rent',
            'utilities',
            'salaries',
            'maintenance',
            'marketing',
            'packaging',
            'logistics',
            'petty_cash',
            'licenses',
            'miscellaneous'
        ],
        default: 'miscellaneous',
        required: true,
        index: true
    },
    amount: {
        type: Number,
        required: [true, 'Expense amount is required'],
        min: [0.01, 'Amount must be greater than zero']
    },
    expenseDate: {
        type: Date,
        default: Date.now,
        required: true,
        index: true
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'upi', 'bank_transfer', 'cheque', 'credit_card', 'other'],
        default: 'upi'
    },
    paymentStatus: {
        type: String,
        enum: ['paid', 'pending', 'cancelled'],
        default: 'paid',
        index: true
    },
    referenceNumber: {
        type: String,
        trim: true
    },
    receiptDocument: {
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

expenseSchema.index({ brand: 1, expenseDate: -1 });
expenseSchema.index({ brand: 1, category: 1 });
expenseSchema.index({ brand: 1, paymentStatus: 1 });

export default mongoose.model('Expense', expenseSchema);

