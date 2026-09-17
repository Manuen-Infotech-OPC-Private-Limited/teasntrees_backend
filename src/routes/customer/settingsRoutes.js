import express from 'express';
import { getPublicSettings, getBrandsStatus } from '../../controllers/customer/settingsController.js';

const router = express.Router({ mergeParams: true });

// Get public settings (no auth required)
router.get('/', getPublicSettings);

// Get brands status (no auth required)
router.get('/brands-status', getBrandsStatus);

export default router;
