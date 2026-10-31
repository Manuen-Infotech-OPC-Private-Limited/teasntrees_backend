import Banner from '../../models/Banner.js';

// GET /api/:brand/admin/banners - List all banners for brand
export const getAllBanners = async (req, res) => {
    try {
        const brand = req.activeBrand;
        const filter = brand ? { brand } : {};
        const banners = await Banner.find(filter).sort({ displayOrder: 1, createdAt: -1 }).lean();
        res.json({ success: true, data: banners });
    } catch (err) {
        console.error('Error fetching banners:', err);
        res.status(500).json({ success: false, message: 'Failed to fetch banners' });
    }
};

// GET /api/:brand/admin/banners/:id - Get single banner
export const getBanner = async (req, res) => {
    try {
        const banner = await Banner.findById(req.params.id).lean();
        if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });
        res.json({ success: true, data: banner });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to fetch banner' });
    }
};

// POST /api/:brand/admin/banners - Create banner
export const createBanner = async (req, res) => {
    try {
        const {
            title, subtitle, description, price, image,
            link, accent, isActive, displayOrder
        } = req.body;

        const brand = req.activeBrand || req.body.brand;
        if (!brand) {
            return res.status(400).json({ success: false, message: 'Brand is required' });
        }

        if (!title || !image) {
            return res.status(400).json({ success: false, message: 'Title and image URL are required' });
        }

        const banner = await Banner.create({
            title: title.trim(),
            subtitle: subtitle ? subtitle.trim() : 'FEATURED',
            description: description ? description.trim() : '',
            price: price !== undefined && price !== '' && price !== null ? Number(price) : null,
            image: image.trim(),
            link: link ? link.trim() : '/menu',
            accent: accent || (brand === 'littleh' ? '#B7410E' : '#10b981'),
            brand,
            isActive: isActive !== undefined ? Boolean(isActive) : true,
            displayOrder: Number(displayOrder) || 0
        });

        res.status(201).json({ success: true, message: 'Banner created successfully', data: banner });
    } catch (err) {
        console.error('Error creating banner:', err);
        res.status(500).json({ success: false, message: err.message || 'Failed to create banner' });
    }
};

// PUT /api/:brand/admin/banners/:id - Update banner
export const updateBanner = async (req, res) => {
    try {
        const {
            title, subtitle, description, price, image,
            link, accent, isActive, displayOrder
        } = req.body;

        const update = {};
        if (title !== undefined) update.title = title.trim();
        if (subtitle !== undefined) update.subtitle = subtitle.trim();
        if (description !== undefined) update.description = description.trim();
        if (price !== undefined) update.price = price !== '' && price !== null ? Number(price) : null;
        if (image !== undefined) update.image = image.trim();
        if (link !== undefined) update.link = link.trim();
        if (accent !== undefined) update.accent = accent;
        if (isActive !== undefined) update.isActive = Boolean(isActive);
        if (displayOrder !== undefined) update.displayOrder = Number(displayOrder) || 0;

        const banner = await Banner.findByIdAndUpdate(req.params.id, update, { new: true });
        if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });

        res.json({ success: true, message: 'Banner updated successfully', data: banner });
    } catch (err) {
        console.error('Error updating banner:', err);
        res.status(500).json({ success: false, message: 'Failed to update banner' });
    }
};

// PATCH /api/:brand/admin/banners/:id/toggle - Toggle active status
export const toggleBanner = async (req, res) => {
    try {
        const banner = await Banner.findById(req.params.id);
        if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });

        banner.isActive = !banner.isActive;
        await banner.save();

        res.json({
            success: true,
            message: `Banner ${banner.isActive ? 'activated' : 'deactivated'}`,
            data: { isActive: banner.isActive }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to toggle banner' });
    }
};

// DELETE /api/:brand/admin/banners/:id - Delete banner
export const deleteBanner = async (req, res) => {
    try {
        const banner = await Banner.findByIdAndDelete(req.params.id);
        if (!banner) return res.status(404).json({ success: false, message: 'Banner not found' });
        res.json({ success: true, message: 'Banner deleted successfully' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to delete banner' });
    }
};

