import express from 'express';
import authRoutes from './authRoutes.js';
import deliveryRoutes from './deliveryRoutes.js';
import supportRoutes from './supportRoutes.js';

const router = express.Router({ mergeParams: true });

router.use('/auth', authRoutes);
router.use('/deliveries', deliveryRoutes);
router.use('/', supportRoutes);

export default router;
