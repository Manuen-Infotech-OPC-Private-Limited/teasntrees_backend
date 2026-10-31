import mongoose from 'mongoose';

export const TNT_VENDOR_CATEGORIES = [
    'tea_leaves',
    'coffee_beans',
    'dairy_milk',
    'syrups_flavors',
    'beverage_powders',
    'snacks_savories',
    'packaging_cups',
    'equipment',
    'cleaning',
    'other'
];

export const LITTLEH_VENDOR_CATEGORIES = [
    'flour_grains',
    'butter_dairy',
    'chocolates_cocoa',
    'fondant_sugars',
    'toppings_fillings',
    'baking_essentials',
    'cake_boxes_packaging',
    'equipment',
    'cleaning',
    'other'
];

export const ALL_VENDOR_CATEGORIES = Array.from(new Set([...TNT_VENDOR_CATEGORIES, ...LITTLEH_VENDOR_CATEGORIES]));

export const VENDOR_CATEGORY_LABELS = {
    teasntrees: {
        tea_leaves: 'Tea Leaves, Herbs & Blends',
        coffee_beans: 'Coffee Beans & Roasts',
        dairy_milk: 'Milk, Creams & Dairy',
        syrups_flavors: 'Syrups, Sauces & Flavors',
        beverage_powders: 'Matcha, Cocoa & Drink Powders',
        snacks_savories: 'Cafe Snacks & Savory Supplies',
        packaging_cups: 'Cups, Lids, Straws & Takeaway Packaging',
        equipment: 'Espresso Machines & Cafe Equipment',
        cleaning: 'Sanitation & Cleaning Supplies',
        other: 'General Cafe Supplies'
    },
    littleh: {
        flour_grains: 'Flours, Premixes & Grains',
        butter_dairy: 'Butter, Whipping Cream & Dairy',
        chocolates_cocoa: 'Chocolates, Compounds & Cocoa',
        fondant_sugars: 'Fondant, Sugars & Sweeteners',
        toppings_fillings: 'Fruit Fillings, Glazes & Sprinkles',
        baking_essentials: 'Yeast, Colors & Essences',
        cake_boxes_packaging: 'Cake Boxes, Boards & Packaging',
        equipment: 'Ovens, Mixers & Baking Equipment',
        cleaning: 'Sanitation & Cleaning Supplies',
        other: 'General Bakery Supplies'
    }
};

const vendorSchema = new mongoose.Schema({
    companyName: {
        type: String,
        required: [true, 'Company name is required'],
        trim: true
    },
    name: {
        type: String,
        required: [true, 'Contact person name is required'],
        trim: true
    },
    brand: {
        type: String,
        enum: ['teasntrees', 'littleh', 'both'],
        default: 'teasntrees',
        required: true,
        index: true
    },
    category: {
        type: String,
        required: [true, 'Category is required'],
        validate: {
            validator: function (v) {
                if (this.brand === 'teasntrees') {
                    return TNT_VENDOR_CATEGORIES.includes(v);
                }
                if (this.brand === 'littleh') {
                    return LITTLEH_VENDOR_CATEGORIES.includes(v);
                }
                return ALL_VENDOR_CATEGORIES.includes(v);
            },
            message: props => `${props.value} is not a valid category for the selected brand.`
        }
    },
    phone: {
        type: String,
        required: [true, 'Phone number is required'],
        trim: true
    },
    email: {
        type: String,
        trim: true,
        lowercase: true
    },
    gstin: {
        type: String,
        trim: true,
        uppercase: true
    },
    address: {
        type: String,
        trim: true
    },
    city: {
        type: String,
        trim: true
    },
    state: {
        type: String,
        trim: true
    },
    pincode: {
        type: String,
        trim: true
    },
    bankDetails: {
        accountName: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        bankName: { type: String, trim: true },
        ifsc: { type: String, trim: true, uppercase: true },
        upiId: { type: String, trim: true }
    },
    paymentTerms: {
        type: String,
        enum: ['immediate', 'net15', 'net30', 'net60', 'cash_on_delivery'],
        default: 'immediate'
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    notes: {
        type: String,
        trim: true
    }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

vendorSchema.index({ brand: 1, companyName: 1 });
vendorSchema.index({ brand: 1, category: 1 });

export default mongoose.model('Vendor', vendorSchema);

