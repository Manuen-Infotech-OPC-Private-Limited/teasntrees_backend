import express from 'express';
import {
    registerRider,
    toggleAvailability,
    getProfile,
    completeProfile,
    firebaseLogin,
    loginRider,
    updateFCMToken,
    getDocument,
    updateRiderDocument,
    refreshRiderToken,
    resetPin
} from '../../controllers/rider/authController.js';
import { riderAuth, isApprovedRider } from '../../middlewares/riderAuth.js';
import multer from 'multer';
import { pinLimiter, authLimiter, pinResetLimiter } from '../../middlewares/rateLimiter.js';
const router = express.Router({ mergeParams: true });

// Use Memory Storage so we can upload to Azure in the controller
const storage = multer.memoryStorage();

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Define Upload Fields
const riderUploads = upload.fields([
    { name: 'licensePhoto', maxCount: 1 },
    { name: 'aadharPhoto', maxCount: 1 },
    { name: 'panPhoto', maxCount: 1 },
    { name: 'profilePhoto', maxCount: 1 }
]);

// Public Routes
router.post('/register', riderUploads, registerRider);
router.post('/firebase-login', firebaseLogin);
router.post('/login', pinLimiter, loginRider);
// A rider who has forgotten their PIN proves they hold the phone (Firebase SMS
// OTP) and chooses a new one. Admins and managers are told every time.
router.post('/reset-pin', pinResetLimiter, resetPin);
// Redeems the 90-day refresh token for a new 1h access token, so a rider isn't
// signed out an hour into their shift.
router.post('/refresh-token', authLimiter, refreshRiderToken);

// Protected Routes
router.post('/availability', riderAuth, isApprovedRider, toggleAvailability);
router.post('/fcm-token', riderAuth, updateFCMToken);
router.get('/profile', riderAuth, getProfile);
router.post('/complete-profile', riderAuth, riderUploads, completeProfile);

// Retrieve private document
router.get('/documents/:filename', riderAuth, getDocument);

// Re-upload a single document from the profile screen
router.post('/documents', riderAuth, upload.single('file'), updateRiderDocument);

export default router;
