// Customer Authentication Routes
// Endpoint: /api/customer/auth

import express from 'express';
import { completeProfile, refreshAccessToken, logout, firebaseLogin, googleLogin, deleteAccount } from '../../controllers/customer/authController.js';
import { authenticate } from '../../middlewares/auth.js';
import { authLimiter } from '../../middlewares/rateLimiter.js';

const router = express.Router({ mergeParams: true });

// Public routes (with rate limiting)
router.post('/firebase-login', authLimiter, firebaseLogin);
router.post('/google-login', authLimiter, googleLogin);
router.post('/refresh-token', authLimiter, refreshAccessToken);

// Protected routes (JWT required)
router.post('/complete-profile', [authenticate, authLimiter], completeProfile);
router.post('/logout', authenticate, logout);
// In-app account deletion: deactivates and anonymises the account
router.delete('/account', [authenticate, authLimiter], deleteAccount);

export default router;
