import Coupon from '../../models/Coupon.js';
import Order from '../../models/Order.js';

/**
 * GET /customer/coupons?brand=xxx
 * Lists active, non-expired coupons visible to customers (no sensitive data).
 * Public – no auth required.
 */
export const getAvailableCoupons = async (req, res) => {
    try {
        const { brand } = req.query;

        const query = {
            isActive: true,
            expiryDate: { $gt: new Date() },
            $or: [
                { brand: null },
                ...(brand ? [{ brand }] : [])
            ]
        };

        const coupons = await Coupon.find(query)
            .select('code description discountType discountAmount maxDiscount minOrderValue brand firstOrderOnly')
            .sort({ createdAt: -1 })
            .lean();

        res.json({ success: true, data: coupons });
    } catch (err) {
        console.error('getAvailableCoupons error:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch coupons' });
    }
};

/**
 * POST /customer/coupons/validate
 * Body: { couponCode, orderValue, brand? }
 * Returns: { valid, discountAmount, finalAmount, coupon }
 */
export const validateCoupon = async (req, res) => {
    try {
        const userId = req.user.userId;
        const { couponCode, orderValue, brand } = req.body;

        if (!couponCode || !orderValue) {
            return res.status(400).json({
                success: false,
                message: 'couponCode and orderValue are required'
            });
        }

        const coupon = await Coupon.findOne({
            code: couponCode.trim().toUpperCase(),
            isActive: true
        });

        // Coupon not found
        if (!coupon) {
            return res.status(404).json({
                success: false,
                message: 'Invalid coupon code'
            });
        }

        // Expiry check
        if (new Date() > new Date(coupon.expiryDate)) {
            return res.status(400).json({
                success: false,
                message: 'This coupon has expired'
            });
        }

        // Brand restriction check
        if (coupon.brand && brand && coupon.brand !== brand) {
            return res.status(400).json({
                success: false,
                message: `This coupon is only valid for ${coupon.brand === 'littleh' ? 'Cream N Crust' : 'Teas N Trees'} orders`
            });
        }

        // Minimum order value check
        if (orderValue < coupon.minOrderValue) {
            return res.status(400).json({
                success: false,
                message: `Minimum order value of ₹${coupon.minOrderValue} required for this coupon`
            });
        }

        // Global usage limit check
        if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
            return res.status(400).json({
                success: false,
                message: 'This coupon has reached its usage limit'
            });
        }

        // Per-user limit check
        if (coupon.perUserLimit !== null) {
            const userEntry = coupon.userUsage.find(
                u => u.userId.toString() === userId.toString()
            );
            const userCount = userEntry ? userEntry.count : 0;
            if (userCount >= coupon.perUserLimit) {
                return res.status(400).json({
                    success: false,
                    message: 'You have already used this coupon'
                });
            }
        }

        // First-order-only check
        if (coupon.firstOrderOnly) {
            const previousOrders = await Order.countDocuments({
                customerId: userId,
                status: { $nin: ['cancelled'] }
            });
            if (previousOrders > 0) {
                return res.status(400).json({
                    success: false,
                    message: 'This coupon is only valid on your first order'
                });
            }
        }

        // Calculate discount
        let discountAmount = 0;
        if (coupon.discountType === 'flat') {
            discountAmount = Math.min(coupon.discountAmount, orderValue);
        } else if (coupon.discountType === 'percentage') {
            discountAmount = (orderValue * coupon.discountAmount) / 100;
            if (coupon.maxDiscount !== null) {
                discountAmount = Math.min(discountAmount, coupon.maxDiscount);
            }
        }

        discountAmount = Math.round(discountAmount * 100) / 100; // round to 2 decimal places
        const finalAmount = Math.max(0, orderValue - discountAmount);

        return res.json({
            success: true,
            message: `Coupon applied! You save ₹${discountAmount}`,
            data: {
                couponCode: coupon.code,
                discountType: coupon.discountType,
                discountAmount,
                finalAmount,
                description: coupon.description
            }
        });

    } catch (error) {
        console.error('Error validating coupon:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to validate coupon'
        });
    }
};
