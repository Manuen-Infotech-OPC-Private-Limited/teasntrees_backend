import Coupon from '../../models/Coupon.js';

// GET /admin/coupons — List all coupons
export const getAllCoupons = async (req, res) => {
    try {
        const filter = req.activeBrand ? { $or: [{ brand: req.activeBrand }, { brand: null }] } : {};
        const coupons = await Coupon.find(filter).sort({ createdAt: -1 }).lean();
        res.json({ success: true, data: coupons });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch coupons' });
    }
};

// GET /admin/coupons/:id — Get single coupon
export const getCoupon = async (req, res) => {
    try {
        const coupon = await Coupon.findById(req.params.id).lean();
        if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
        res.json({ success: true, data: coupon });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch coupon' });
    }
};

// POST /admin/coupons — Create coupon
export const createCoupon = async (req, res) => {
    try {
        const {
            code, description, discountType, discountAmount,
            maxDiscount, minOrderValue, brand,
            usageLimit, perUserLimit, firstOrderOnly, expiryDate, isActive
        } = req.body;

        if (!code || !discountType || discountAmount == null || !expiryDate) {
            return res.status(400).json({
                success: false,
                message: 'code, discountType, discountAmount, and expiryDate are required'
            });
        }

        if (!['percentage', 'flat'].includes(discountType)) {
            return res.status(400).json({ success: false, message: 'discountType must be "percentage" or "flat"' });
        }

        const existing = await Coupon.findOne({ code: code.trim().toUpperCase() });
        if (existing) {
            return res.status(409).json({ success: false, message: 'A coupon with this code already exists' });
        }

        const coupon = await Coupon.create({
            code: code.trim().toUpperCase(),
            description: description || '',
            discountType,
            discountAmount: Number(discountAmount),
            maxDiscount: maxDiscount != null ? Number(maxDiscount) : null,
            minOrderValue: Number(minOrderValue) || 0,
            brand: brand || req.activeBrand || null,
            usageLimit: usageLimit != null ? Number(usageLimit) : null,
            perUserLimit: perUserLimit != null ? Number(perUserLimit) : 1,
            firstOrderOnly: Boolean(firstOrderOnly),
            expiryDate: new Date(expiryDate),
            isActive: isActive !== undefined ? Boolean(isActive) : true
        });

        res.status(201).json({ success: true, message: 'Coupon created', data: coupon });
    } catch (err) {
        console.error('Error creating coupon:', err);
        res.status(500).json({ success: false, message: 'Failed to create coupon' });
    }
};

// PUT /admin/coupons/:id — Update coupon
export const updateCoupon = async (req, res) => {
    try {
        const {
            description, discountType, discountAmount,
            maxDiscount, minOrderValue, brand,
            usageLimit, perUserLimit, firstOrderOnly, expiryDate, isActive
        } = req.body;

        const update = {};
        if (description !== undefined) update.description = description;
        if (discountType !== undefined) update.discountType = discountType;
        if (discountAmount !== undefined) update.discountAmount = Number(discountAmount);
        if (maxDiscount !== undefined) update.maxDiscount = maxDiscount !== null ? Number(maxDiscount) : null;
        if (minOrderValue !== undefined) update.minOrderValue = Number(minOrderValue);
        if (brand !== undefined) update.brand = brand || null;
        if (usageLimit !== undefined) update.usageLimit = usageLimit !== null ? Number(usageLimit) : null;
        if (perUserLimit !== undefined) update.perUserLimit = perUserLimit !== null ? Number(perUserLimit) : null;
        if (firstOrderOnly !== undefined) update.firstOrderOnly = Boolean(firstOrderOnly);
        if (expiryDate !== undefined) update.expiryDate = new Date(expiryDate);
        if (isActive !== undefined) update.isActive = Boolean(isActive);

        const coupon = await Coupon.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });

        res.json({ success: true, message: 'Coupon updated', data: coupon });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to update coupon' });
    }
};

// PATCH /admin/coupons/:id/toggle — Toggle active/inactive
export const toggleCoupon = async (req, res) => {
    try {
        const coupon = await Coupon.findById(req.params.id);
        if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });

        coupon.isActive = !coupon.isActive;
        await coupon.save();

        res.json({
            success: true,
            message: `Coupon ${coupon.isActive ? 'activated' : 'deactivated'}`,
            data: { isActive: coupon.isActive }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to toggle coupon' });
    }
};

// DELETE /admin/coupons/:id — Delete coupon
export const deleteCoupon = async (req, res) => {
    try {
        const coupon = await Coupon.findByIdAndDelete(req.params.id);
        if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found' });
        res.json({ success: true, message: 'Coupon deleted' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete coupon' });
    }
};
