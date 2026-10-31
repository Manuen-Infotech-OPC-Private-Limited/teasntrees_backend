import express from 'express';
import {
    getAllBanners,
    getBanner,
    createBanner,
    updateBanner,
    toggleBanner,
    deleteBanner
} from '../../controllers/admin/bannerController.js';
import { logActivity } from '../../middlewares/activityLogger.js';

const router = express.Router();

router.get('/', getAllBanners);
router.get('/:id', getBanner);
router.post('/', logActivity('create', 'banner'), createBanner);
router.put('/:id', logActivity('update', 'banner'), updateBanner);
router.patch('/:id/toggle', logActivity('update', 'banner'), toggleBanner);
router.delete('/:id', logActivity('delete', 'banner'), deleteBanner);

export default router;

