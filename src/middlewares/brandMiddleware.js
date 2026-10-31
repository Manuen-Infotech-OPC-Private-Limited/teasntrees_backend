// Middleware to handle multi-brand routing via URL params
// Extract :brand from URL, validate and set req.activeBrand

export const brandMiddleware = (req, res, next) => {
    const { brand } = req.params;
    const allowedBrands = ['littleh', 'teasntrees'];

    // Try extracting brand from URL, query, or headers
    const activeBrand = (brand || req.query.brand || req.headers['x-brand'])?.toLowerCase();

    if (!activeBrand) {
        // If not specified anywhere, it might be an optional route (like generic rider routes)
        // Check if the route is a customer route, which we default to teasntrees
        if (req.originalUrl.includes('/customer')) {
            req.activeBrand = 'teasntrees';
            return next();
        }
        return next();
    }

    if (!allowedBrands.includes(activeBrand)) {
        return res.status(400).json({
            success: false,
            message: `Invalid brand: ${activeBrand}. Allowed brands are: ${allowedBrands.join(', ')}`
        });
    }

    req.activeBrand = activeBrand;
    next();
};
