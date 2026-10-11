/**
 * Middleware to enforce brand-specific access control.
 * Ensures that 'manager' and 'admin' users can only access routes 
 * matching their assigned brand.
 */
export const brandGuard = (req, res, next) => {
    if (!req.user) {
        return next();
    }
    const activeBrand = req.activeBrand;
    const userBrand = req.user.brand;
    const userRole = req.user.role;

    if (userRole === 'customer') {
        return next();
    }

    if (userBrand && activeBrand && userBrand !== activeBrand) {
        return res.status(403).json({
            success: false,
            message: `Access denied. Your account is assigned to ${userBrand === 'teasntrees' ? 'Teas N Trees' : 'Cream N Crust'}. Please use the correct dashboard.`
        });
    }

    next();
};
