// Customer Category Controller
// Public access to browse categories

import Category from '../../models/Category.js';
import Product from '../../models/Product.js';
import { getCurrentMonth } from '../../utils/seasonUtils.js';

// Simple in-memory cache for category listings
const categoryCache = new Map();
const CACHE_TTL = 5000;

const getCachedResponse = (key) => {
    const cached = categoryCache.get(key);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        return cached.data;
    }
    return null;
};

const setCachedResponse = (key, data) => {
    categoryCache.set(key, { data, timestamp: Date.now() });
};

// Clear cache (can be exported and used in other controllers on update)
export const clearCategoryCache = () => categoryCache.clear();

// Get all categories
export const getAllCategories = async (req, res) => {
    try {
        // Check cache first
        const activeBrand = req.activeBrand || 'teasntrees';
        const cacheKey = `categories:${activeBrand}`;
        const cachedData = getCachedResponse(cacheKey);
        if (cachedData) return res.json(cachedData);

        const query = { isActive: true };

        if (req.activeBrand) {
            query.brand = req.activeBrand;
        }

        const categories = await Category.find(query)
            .select('-__v')
            .sort({ name: 1 })
            .lean();

        // Attach a live product count per category so the app's menu sheet can
        // show "Sweets 122" etc. Match the same visibility filter the product
        // listing uses (available, in-season, this brand) so the numbers agree
        // with what actually shows up when you tap into a category.
        const currentMonth = getCurrentMonth();
        const countMatch = { isAvailable: true, availableMonths: currentMonth };
        if (req.activeBrand) countMatch.brand = req.activeBrand;

        const counts = await Product.aggregate([
            { $match: countMatch },
            { $group: { _id: '$category', count: { $sum: 1 } } }
        ]);
        const countMap = new Map(counts.map(c => [String(c._id), c.count]));

        const data = categories.map(c => ({
            ...c,
            productCount: countMap.get(String(c._id)) || 0
        }));

        const responseData = {
            success: true,
            data
        };

        // Cache the result
        setCachedResponse(cacheKey, responseData);

        res.json(responseData);
    } catch (error) {
        console.error('Error in getAllCategories:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch categories'
        });
    }
};

// Get single category by ID
export const getCategoryById = async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);

        if (!category || !category.isActive) {
            return res.status(404).json({
                success: false,
                message: 'Category not found'
            });
        }

        res.json({
            success: true,
            data: category
        });
    } catch (error) {
        console.error('Error in getCategoryById:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch category'
        });
    }
};
