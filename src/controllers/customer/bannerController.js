import Banner from '../../models/Banner.js';

// GET /api/:brand/customer/banners - List active banners for customer frontend
export const getActiveBanners = async (req, res) => {
    try {
        const brand = req.activeBrand || 'teasntrees';
        const banners = await Banner.find({ brand, isActive: true })
            .sort({ displayOrder: 1, createdAt: -1 })
            .lean();

        res.json({
            success: true,
            data: banners
        });
    } catch (err) {
        console.error('Error fetching customer banners:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch banners' });
    }
};

