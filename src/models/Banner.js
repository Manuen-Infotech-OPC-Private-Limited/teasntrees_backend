import mongoose from 'mongoose';

const bannerSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Banner title is required'],
        trim: true
    },
    subtitle: {
        type: String,
        default: 'FEATURED',
        trim: true
    },
    description: {
        type: String,
        default: '',
        trim: true
    },
    price: {
        type: Number,
        default: null
    },
    image: {
        type: String,
        required: [true, 'Banner image URL is required'],
        trim: true
    },
    link: {
        type: String,
        default: '/menu',
        trim: true
    },
    accent: {
        type: String,
        default: '#10b981'
    },
    brand: {
        type: String,
        enum: ['teasntrees', 'littleh'],
        required: true,
        index: true
    },
    isActive: {
        type: Boolean,
        default: true,
        index: true
    },
    displayOrder: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true
});

bannerSchema.index({ brand: 1, isActive: 1, displayOrder: 1 });

const Banner = mongoose.model('Banner', bannerSchema);

export default Banner;

