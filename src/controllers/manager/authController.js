// Manager Authentication Controller
// Role: 'manager'
// App: Manager Panel (future) or Admin Panel (shared)

import User from '../../models/User.js';
import Manager from '../../models/Manager.js';
import RefreshToken from '../../models/RefreshToken.js';
import { generateToken, generateRefreshToken } from '../../utils/jwtHelper.js';
import { isValidEmail, sanitizeString } from '../../utils/validators.js';
import logger from '../../config/logger.js';
import activityLogService from '../../services/activityLogService.js';
import { verifyFirebaseToken } from '../../services/firebaseAuth.js';

// Complete manager profile after Firebase login (requires JWT)
const completeProfile = async (req, res) => {
    try {
        const { name, email, address } = req.body;

        // 1. Identify User via JWT (Enforced by route middleware)
        if (!req.user || !req.user.userId) {
            return res.status(401).json({ success: false, message: 'Authentication required' });
        }

        const user = await User.findById(req.user.userId);
        if (!user) return res.status(404).json({ success: false, message: 'User not found' });

        const mobileNumber = user.mobile;

        if (!name || !email || !address) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // update user
        user.name = sanitizeString(name);
        user.email = sanitizeString(email).toLowerCase();
        user.address = sanitizeString(address);
        user.isProfileComplete = true;
        user.role = 'manager';
        user.kind = 'Manager';

        await user.save();

        // For Managers, wait for approval
        if (!user.isApproved) {
            return res.status(200).json({
                success: true,
                message: 'Profile completed. Please wait for Admin approval to log in.',
                data: {
                    user: {
                        id: user._id,
                        name: user.name,
                        mobile: user.mobile,
                        role: user.role,
                        isProfileComplete: true,
                        isApproved: false
                    }
                }
            });
        }

        const token = generateToken({ userId: user._id, role: user.role });
        const refreshToken = generateRefreshToken();

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: refreshToken,
            user: user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

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
                    role: user.role,
                    isProfileComplete: user.isProfileComplete,
                    isApproved: user.isApproved
                }
            }
        });

    } catch (error) {
        console.error('Error in completeProfile:', error);
        if (error.code === 11000 && error.keyPattern?.email) {
            return res.status(400).json({ success: false, message: 'Email already in use' });
        }
        return res.status(500).json({ success: false, message: 'Failed to complete profile' });
    }
};

const refreshAccessToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(401).json({ success: false, message: 'Refresh token required' });

        const storedToken = await RefreshToken.findOne({ token: refreshToken, isRevoked: false }).populate('user');
        if (!storedToken) return res.status(401).json({ success: false, message: 'Invalid refresh token' });

        if (storedToken.expiresAt < new Date()) {
            return res.status(401).json({ success: false, message: 'Refresh token expired' });
        }

        // Revoke old
        storedToken.isRevoked = true;
        storedToken.revokedAt = new Date();

        const newRefreshToken = generateRefreshToken();
        storedToken.replacedBy = newRefreshToken;
        await storedToken.save();

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: newRefreshToken,
            user: storedToken.user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        const accessToken = generateToken({
            userId: storedToken.user._id,
            role: storedToken.user.role
        });

        res.json({ success: true, token: accessToken, refreshToken: newRefreshToken });

    } catch (error) {
        console.error('Error in refreshAccessToken', error);
        return res.status(500).json({ success: false, message: 'Failed to refresh token' });
    }
};

const logout = async (req, res) => {
    try {
        const { refreshToken } = req.body || {};
        if (refreshToken) {
            await RefreshToken.updateOne({ token: refreshToken }, { isRevoked: true, revokedAt: new Date() });
        }
        res.status(200).json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Failed to logout' });
    }
};

// Firebase-based login
const firebaseLogin = async (req, res) => {
    try {
        const { idToken } = req.body;
        if (!idToken) {
            return res.status(400).json({
                success: false,
                message: 'Firebase ID token is required'
            });
        }

        // 1. Verify token
        const decoded = await verifyFirebaseToken(idToken);
        const mobile = decoded.phone_number.replace(/\D/g, '').slice(-10);

        // 2. Find/Create Manager
        let user = await Manager.findOne({ mobile });
        
        // Fallback: user exists but was created without Manager discriminator (legacy)
        if (!user) {
            const legacyUser = await User.findOne({ mobile, role: 'manager' });
            if (legacyUser) {
                await User.updateOne({ _id: legacyUser._id }, { $set: { kind: 'Manager' } });
                user = await Manager.findById(legacyUser._id);
                logger.info('Auto-healed Manager discriminator kind field (mobile)', { userId: legacyUser._id });
            }
        }
        
        let isNewUser = false;

        if (!user) {
            isNewUser = true;
            user = await Manager.create({
                mobile,
                role: 'manager',
                brand: req.activeBrand,
                isApproved: false // Default to false
            });
            logger.info('New manager registered via Firebase', { mobile, userId: user._id });
        } else {
            if (user.role !== 'manager') {
                return res.status(403).json({
                    success: false,
                    message: `Account already exists with role: ${user.role}`
                });
            }

            if (!user.isActive) {
                return res.status(403).json({
                    success: false,
                    message: 'Account is deactivated. Please contact support.'
                });
            }

            // Check brand restriction
            if (user.brand && user.brand !== req.activeBrand) {
                return res.status(403).json({
                    success: false,
                    message: `This account is registered with ${user.brand === 'teasntrees' ? 'Teas N Trees' : 'Cream N Crust'}. Please log in through the correct portal.`
                });
            }

            // For existing managers who don't have a brand yet (unlikely since Manager had brand, but for safety)
            if (!user.brand) {
                user.brand = req.activeBrand;
                await user.save();
            }

            // Auto-heal isProfileComplete flag
            if (!user.isProfileComplete && user.checkProfileComplete()) {
                user.isProfileComplete = true;
                await user.save();
                logger.info('Auto-healed manager profile completion flag', { userId: user._id });
            }
        }

        // 3. Tokens
        const token = generateToken({ userId: user._id, role: user.role });
        const refreshToken = generateRefreshToken();
        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 90);

        await RefreshToken.create({
            token: refreshToken,
            user: user._id,
            expiresAt,
            ipAddress: req.ip,
            userAgent: req.headers['user-agent']
        });

        // Log Activity
        await activityLogService.log(req, {
            adminId: user._id,
            action: 'firebase_login',
            resource: 'user',
            resourceId: user._id,
            details: { mobile: user.mobile, role: user.role, isNewUser }
        });

        // If new user or profile incomplete, return special status
        if (isNewUser || !user.isProfileComplete) {
            return res.status(200).json({
                success: true,
                message: 'Profile incomplete. Please complete your profile.',
                data: {
                    token,
                    refreshToken,
                    user: {
                        id: user._id,
                        name: user.name,
                        mobile: user.mobile,
                        role: user.role,
                        isProfileComplete: user.isProfileComplete,
                        isApproved: user.isApproved || false
                    },
                    isNewUser
                }
            });
        }

        // Check approval if profile is complete
        if (!user.isApproved) {
            return res.status(403).json({
                success: false,
                message: 'Account pending approval. Please wait for admin verification.'
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
                    email: user.email,
                    role: user.role,
                    isProfileComplete: user.isProfileComplete,
                    isApproved: user.isApproved
                }
            }
        });

    } catch (error) {
        logger.error('Firebase login error (Manager):', error);
        return res.status(401).json({ success: false, message: error.message });
    }
};

export {
    completeProfile,
    refreshAccessToken,
    logout,
    firebaseLogin
};
