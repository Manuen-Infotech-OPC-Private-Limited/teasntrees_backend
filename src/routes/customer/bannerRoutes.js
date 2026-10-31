import express from 'express';
import { getActiveBanners } from '../../controllers/customer/bannerController.js';

const router = express.Router();

router.get('/', getActiveBanners);

export default router;

