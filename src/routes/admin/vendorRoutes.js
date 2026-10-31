import express from 'express';
import {
    getVendors,
    getVendorCategories,
    getVendorById,
    createVendor,
    updateVendor,
    deleteVendor,
    getVendorStats
} from '../../controllers/admin/vendorController.js';
import { logActivity } from '../../middlewares/activityLogger.js';

const router = express.Router({ mergeParams: true });

router.get('/categories', getVendorCategories);
router.get('/stats', getVendorStats);
router.get('/', getVendors);
router.get('/:id', getVendorById);
router.post('/', logActivity('create', 'vendor'), createVendor);
router.put('/:id', logActivity('update', 'vendor'), updateVendor);
router.delete('/:id', logActivity('delete', 'vendor'), deleteVendor);

export default router;

