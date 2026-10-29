// Customer Authentication Controller
// Role: 'customer' (auto-assigned)
// App: Customer App

import { deleteCustomerAccount, DeletionBlockedError } from '../../services/accountDeletionService.js';
import User from '../../models/User.js';
import Customer from '../../models/Customer.js';
import RefreshToken from '../../models/RefreshToken.js';
import { generateToken, generateRefreshToken } from '../../utils/jwtHelper.js';
import { isValidEmail, sanitizeString } from '../../utils/validators.js';
import logger from '../../config/logger.js';
import activityLogService from '../../services/activityLogService.js';
import { statsService } from '../../services/statsService.js';
import { geocodingService } from '../../services/geocodingService.js';
import { SOCKET_EVENTS, SOCKET_ROOMS } from '../../sockets/socketEvents.js';
import { verifyFirebaseToken } from '../../services/firebaseAuth.js';

// Complete user profile after Firebase login (requires JWT)
const completeProfile = async (req, res) => {
    try {
        const { name, email, address, mobile } = req.body;

        // 1. Identify User via JWT (Enforced by route middleware)
        if (!req.user || !req.user.userId) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        // 2. Validate required fields for profile completion
        if (!name || !address) {
            return res.status(400).json({
                success: false,
                message: 'Please provide all required fields: name, address'
            });
        }

        // For new Google users, mobile is required
        if (!user.mobile && !mobile) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required for profile completion'
            });
        }

        // If mobile is provided, validate it
        if (mobile) {
            const mobileRegex = /^[0-9]{10}$/;
            if (!mobileRegex.test(mobile.toString().replace(/\D/g, ''))) {
                return res.status(400).json({
                    success: false,
                    message: 'Please provide a valid 10-digit mobile number'
                });
            }

            // Check if mobile is already in use by another customer
            const existingUser = await Customer.findOne({
                mobile: mobile.toString().replace(/\D/g, ''),
                _id: { $ne: user._id }
            });
            if (existingUser) {
                return res.status(400).json({
                    success: false,
                    message: 'This phone number is already registered'
                });
            }

            user.mobile = mobile.toString().replace(/\D/g, '');
        }

        // 3. Update user profile
        user.name = sanitizeString(name);
        if (email) {
            user.email = sanitizeString(email).toLowerCase();
        }
        user.address = sanitizeString(address);
        user.isProfileComplete = true;

        // Use geocoding service for coordinates if not provided
        if (req.body.location) {
            user.location = req.body.location;
        } else if (user.address) {
            try {
                const coords = await geocodingService.getCoordinates(user.address);
                if (coords) {
                    user.location = {
                        type: 'Point',
                        coordinates: [coords.lng, coords.lat]
                    };
                }
            } catch (geoError) {
                console.warn('Geocoding failed during profile completion:', geoError);
            }
        }

        // Ensure role is customer
        if (!user.role) user.role = 'customer';

        await user.save();

        // Generate JWT token (may refresh if needed)
        const token = generateToken({
            userId: user._id,
            role: user.role
        });

        // Generate refresh token
        const refreshToken = generateRefreshToken();

        // Store refresh token in database
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90); // 90 days

        await RefreshToken.create({
            token: refreshToken,
            user: user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Emit socket event for admin dashboard
        const io = req.app.get('io');
        if (io) {
            io.to(SOCKET_ROOMS.role('admin')).to(SOCKET_ROOMS.role('manager')).emit(SOCKET_EVENTS.USER_REGISTERED, {
                userId: user._id,
                name: user.name,
                role: user.role,
                totalCustomers: (await statsService.getStats()).totalCustomers
            });
        }

        logger.info('Profile completed successfully', { userId: user._id, mobile: user.mobile });

        return res.status(200).json({
            success: true,
            message: 'Profile completed successfully',
            data: {
                token,
                refreshToken,
                user: {
                    id: user._id,
                    name: user.name,
                    mobile: user.mobile,
                    email: user.email,
                    address: user.address,
                    profileImage: user.profileImage,
                    role: user.role,
                    isProfileComplete: user.isProfileComplete,
                    activeBrand: user.preferences?.activeBrand
                }
            }
        });

    } catch (error) {
        logger.error('Error in completeProfile:', error);

        // Handle duplicate mobile error
        if (error.code === 11000 && error.keyPattern?.mobile) {
            return res.status(400).json({
                success: false,
                message: 'Phone number already in use'
            });
        }

        // Handle duplicate email error
        if (error.code === 11000 && error.keyPattern?.email) {
            return res.status(400).json({
                success: false,
                message: 'Email already in use'
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Failed to complete profile. Please try again.'
        });
    }
};

// Refresh access token using refresh token
const refreshAccessToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            logger.warn('Refresh token missing in request');
            return res.status(401).json({
                success: false,
                message: 'Refresh token required'
            });
        }

        // Find token in database
        const storedToken = await RefreshToken.findOne({
            token: refreshToken,
            isRevoked: false
        }).populate('user');

        if (!storedToken) {
            logger.warn('Invalid refresh token attempt', { token: refreshToken.substring(0, 20) });
            return res.status(401).json({
                success: false,
                message: 'Invalid or revoked refresh token'
            });
        }

        // Check expiry
        if (storedToken.expiresAt < new Date()) {
            logger.warn('Expired refresh token', { userId: storedToken.user._id });
            return res.status(401).json({
                success: false,
                message: 'Refresh token expired. Please login again.'
            });
        }

        // Check if user is still active
        if (!storedToken.user.isActive) {
            logger.warn('Refresh attempt by deactivated user', { userId: storedToken.user._id });
            return res.status(403).json({
                success: false,
                message: 'Account is deactivated'
            });
        }

        // TOKEN ROTATION: Revoke old token
        storedToken.isRevoked = true;
        storedToken.revokedAt = new Date();

        const newRefreshToken = generateRefreshToken();
        storedToken.replacedBy = newRefreshToken;
        await storedToken.save();

        // Create new refresh token
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: newRefreshToken,
            user: storedToken.user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Generate new access token
        const accessToken = generateToken({
            userId: storedToken.user._id,
            role: storedToken.user.role
        });

        logger.info('Token refreshed successfully', { userId: storedToken.user._id });

        res.json({
            success: true,
            token: accessToken,
            refreshToken: newRefreshToken
        });

    } catch (error) {
        logger.error('Error in refreshAccessToken', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'Failed to refresh token'
        });
    }
};


const logout = async (req, res) => {
    try {
        const { refreshToken } = req.body || {};

        if (refreshToken) {
            const result = await RefreshToken.updateOne(
                { token: refreshToken },
                {
                    isRevoked: true,
                    revokedAt: new Date()
                }
            );

            logger.info('User logged out', {
                tokenRevoked: result.modifiedCount > 0
            });
        }

        res.status(200).json({
            success: true,
            message: 'Logged out successfully'
        });
    } catch (error) {
        logger.error('Error in logout', { error: error.message });
        return res.status(500).json({
            success: false,
            message: 'Failed to logout'
        });
    }
};

// Firebase-based login/signup
const firebaseLogin = async (req, res) => {
    try {
        const { idToken, mobile } = req.body;
        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: 'Firebase ID token is required'
            });
        }

        if (!mobile) {
            return res.status(400).json({
                success: false,
                message: 'Phone number is required'
            });
        }

        // 1. Verify the Firebase token
        const decoded = await verifyFirebaseToken(idToken);

        // Phone number comes from frontend request body (sent by client after Firebase OTP confirmation)
        // idToken is verified with Firebase to ensure authenticity

        // 3. Find or create the user in DB
        let user = await Customer.findOne({ mobile });

        // Fallback: user exists but was created without Customer discriminator (legacy)
        if (!user) {
            const legacyUser = await User.findOne({ mobile, role: 'customer' });
            if (legacyUser) {
                // Heal: set kind to Customer so discriminator works going forward
                await User.updateOne({ _id: legacyUser._id }, { $set: { kind: 'Customer' } });
                user = await Customer.findById(legacyUser._id);
                logger.info('Auto-healed Customer discriminator kind field (mobile)', { userId: legacyUser._id });
            }
        }

        let isNewUser = false;

        if (!user) {
            isNewUser = true;
            user = await Customer.create({
                mobile,
                role: 'customer'
            });

            logger.info('New customer registered via Firebase', { mobile, userId: user._id });
        } else {
            if (user.role !== 'customer') {
                return res.status(403).json({
                    success: false,
                    message: `Account already exists with role: ${user.role}`
                });
            }

            // Auto-heal isProfileComplete flag if data exists but flag is false
            if (!user.isProfileComplete && user.checkProfileComplete()) {
                user.isProfileComplete = true;
                await user.save();
                logger.info('Auto-healed profile completion flag', { userId: user._id });
            }
        }

        // 4. Issue backend JWT and Refresh Token
        const token = generateToken({ userId: user._id, role: user.role });
        const refreshToken = generateRefreshToken();

        // Store refresh token in database (consistent with other roles)
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: refreshToken,
            user: user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // 5. Update stats
        if (isNewUser) await statsService.increment('totalCustomers');

        // 6. Log Activity
        await activityLogService.log(req, {
            adminId: user._id,
            action: 'firebase_login',
            resource: 'user',
            resourceId: user._id,
            details: { mobile: user.mobile, role: user.role, isNewUser }
        });

        // 7. Handle response (Cookie for Web, JSON for Mobile)
        const isMobile = req.headers['x-client-type'] === 'mobile';

        if (!isMobile) {
            res.cookie('token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'none',
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                token,
                refreshToken,
                user: {
                    id: user._id,
                    name: user.name,
                    mobile: user.mobile,
                    role: user.role,
                    isProfileComplete: user.isProfileComplete,
                    activeBrand: user.preferences?.activeBrand
                },
                isNewUser
            }
        });

    } catch (error) {
        logger.error('Firebase login error:', error);
        return res.status(401).json({
            success: false,
            message: error.message || 'Invalid or expired Firebase token'
        });
    }
};

// Google-based login/signup
const googleLogin = async (req, res) => {
    try {
        const { idToken, name, photoURL } = req.body;

        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: 'Firebase ID token is required'
            });
        }

        // 1. Verify the Firebase token
        const decoded = await verifyFirebaseToken(idToken);

        // Identity comes from the verified token, never from the request body
        // (reading the email from the body let anyone with any valid token name
        // someone else's email and get their account).
        //
        // The Firebase uid is the key: Apple shares the email only on the very
        // first sign-in to an app, so a retry - or anyone whose first attempt
        // failed - arrives with no email at all, and used to be turned away.
        const uid = decoded.uid;
        const email = decoded.email ? decoded.email.toLowerCase() : null;

        // 2. Find the customer: by Firebase account, then by email
        // Use Customer discriminator so Customer.findById works in other controllers
        let user = uid ? await Customer.findOne({ firebaseUid: uid }) : null;
        if (!user && email) user = await Customer.findOne({ email });

        // Fallback: user exists but was created without Customer discriminator (legacy)
        if (!user && email) {
            const legacyUser = await User.findOne({ email, role: 'customer' });
            if (legacyUser) {
                // Heal: set kind to Customer so discriminator works going forward
                await User.updateOne({ _id: legacyUser._id }, { $set: { kind: 'Customer' } });
                user = await Customer.findById(legacyUser._id);
                logger.info('Auto-healed Customer discriminator kind field', { userId: legacyUser._id });
            }
        }

        let isNewUser = false;

        if (!user) {
            isNewUser = true;
            user = await Customer.create({
                email,
                firebaseUid: uid || null,
                name: name || (email ? email.split('@')[0] : null),
                profileImage: photoURL || null,
                role: 'customer'
                // Note: mobile (and, for Apple, maybe email) are NOT set here -
                // the customer provides them in completeProfile
            });

            logger.info('New customer registered via social sign-in', { userId: user._id, hasEmail: !!email });
        } else {
            // Remember the Firebase account, so the next sign-in finds them
            // even without an email.
            if (uid && !user.firebaseUid) user.firebaseUid = uid;

            // Update profile picture if provided and not yet set
            if (photoURL && !user.profileImage) {
                user.profileImage = photoURL;
            }

            if (user.role !== 'customer') {
                return res.status(403).json({
                    success: false,
                    message: `Account already exists with role: ${user.role}`
                });
            }

            // Auto-heal isProfileComplete flag if data exists but flag is false
            if (!user.isProfileComplete && user.checkProfileComplete()) {
                user.isProfileComplete = true;
                await user.save();
                logger.info('Auto-healed profile completion flag', { userId: user._id });
            }
        }

        // Save any updates
        await user.save();

        // 3. Issue backend JWT and Refresh Token (even if profile incomplete)
        const token = generateToken({ userId: user._id, role: user.role });
        const refreshToken = generateRefreshToken();

        // Store refresh token in database
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: refreshToken,
            user: user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        const isMobile = req.headers['x-client-type'] === 'mobile';

        if (!isMobile) {
            res.cookie('token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'none',
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
        }

        // 4. Update stats
        if (isNewUser) await statsService.increment('totalCustomers');

        // 5. Log Activity
        await activityLogService.log(req, {
            adminId: user._id,
            action: 'google_login',
            resource: 'user',
            resourceId: user._id,
            details: { email: user.email, role: user.role, isNewUser }
        });

        logger.info('Google login successful', { userId: user._id, email: user.email });

        // 6. Check if additional data needed
        if (!user.mobile) {
            // New Google user - needs to provide phone number
            return res.status(200).json({
                success: true,
                message: 'Login successful - phone number required',
                data: {
                    token,
                    refreshToken,
                    user: {
                        id: user._id,
                        name: user.name,
                        email: user.email,
                        mobile: null,
                        profileImage: user.profileImage,
                        role: user.role,
                        isProfileComplete: user.isProfileComplete,
                        activeBrand: user.preferences?.activeBrand
                    },
                    isNewUser,
                    requiresPhone: true
                }
            });
        }

        return res.status(200).json({
            success: true,
            message: 'Login successful',
            data: {
                token,
                refreshToken,
                user: {
                    id: user._id,
                    name: user.name,
                    email: user.email,
                    mobile: user.mobile,
                    profileImage: user.profileImage,
                    role: user.role,
                    isProfileComplete: user.isProfileComplete,
                    activeBrand: user.preferences?.activeBrand
                },
                isNewUser
            }
        });

    } catch (error) {
        logger.error('Google login error:', error);
        return res.status(401).json({
            success: false,
            message: error.message || 'Invalid or expired Firebase token'
        });
    }
};

// Delete my account (deactivate + anonymise; see accountDeletionService)
const deleteAccount = async (req, res) => {
    try {
        const deleted = await deleteCustomerAccount(req.user.userId);
        if (!deleted) {
            return res.status(404).json({ success: false, message: 'Account not found' });
        }
        res.status(200).json({ success: true, message: 'Your account has been deleted.' });
    } catch (error) {
        if (error instanceof DeletionBlockedError) {
            return res.status(409).json({ success: false, message: error.message });
        }
        logger.error('Error deleting customer account', { error: error.message });
        return res.status(500).json({ success: false, message: 'Could not delete your account. Please try again.' });
    }
};

export {
    deleteAccount,
    completeProfile,
    refreshAccessToken,
    logout,
    firebaseLogin,
    googleLogin
};
