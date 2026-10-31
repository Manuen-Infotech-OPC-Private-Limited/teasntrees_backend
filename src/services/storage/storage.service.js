import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

const PUBLIC_ROOT = process.env.STORAGE_PUBLIC_PATH || path.join(process.cwd(), 'uploads', 'public');
const PRIVATE_ROOT = process.env.STORAGE_PRIVATE_PATH || path.join(process.cwd(), 'uploads', 'private');
const PUBLIC_BASE_URL = process.env.STORAGE_PUBLIC_BASE_URL || 'http://localhost:5000/public';

/**
 * Normalizes a folder name
 */
const getRootForFolder = (folder) => {
    const publicFolders = ['products', 'categories', 'profiles', 'promotions', 'brands', 'teasntrees', 'banners'];
    return publicFolders.includes(folder) ? PUBLIC_ROOT : PRIVATE_ROOT;
};

export const storageService = {
    /**
     * Save a file buffer to disk
     * @param {Buffer} buffer - File buffer
     * @param {string} folder - Target folder
     * @param {string} extension - File extension without dot (e.g., 'webp', 'pdf')
     * @returns {Promise<{ url: string, relativePath: string, publicId: string }>}
     */
    async saveFile(buffer, folder = 'temp', extension = 'webp') {
        const rootPath = getRootForFolder(folder);
        const targetDir = path.join(rootPath, folder);
        
        // Ensure directory exists
        await fs.mkdir(targetDir, { recursive: true });

        const filename = `${uuidv4()}-${Date.now()}.${extension}`;
        const absolutePath = path.join(targetDir, filename);
        
        await fs.writeFile(absolutePath, buffer);

        const relativePath = path.posix.join(folder, filename);
        
        let url;
        if (rootPath === PUBLIC_ROOT) {
            url = `${PUBLIC_BASE_URL}/${relativePath}`;
        } else {
            // Private files are served through API
            url = `/api/rider/documents/${filename}?folder=${folder}`;
        }

        return {
            url,
            relativePath,
            publicId: relativePath // Using relativePath as the identifier
        };
    },

    /**
     * Delete a file from disk
     * @param {string} publicId - The relative path or identifier
     */
    async deleteFile(publicId) {
        if (!publicId) return false;
        
        try {
            // Extract folder and filename from publicId
            const parts = publicId.split('/');
            const folder = parts.length > 1 ? parts[0] : 'temp';
            
            const rootPath = getRootForFolder(folder);
            const absolutePath = path.join(rootPath, publicId);

            await fs.unlink(absolutePath);
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') {
                return true; // File already deleted
            }
            console.error(`Failed to delete file ${publicId}:`, error);
            return false;
        }
    },

    /**
     * Extract publicId from URL
     * @param {string} url - The URL to extract from
     */
    extractPublicId(url) {
        if (!url) return null;
        try {
            // Handle public URLs
            if (url.startsWith(PUBLIC_BASE_URL)) {
                return url.substring(PUBLIC_BASE_URL.length + 1); // +1 to remove leading slash
            }
            
            // Handle private URLs (e.g. /api/rider/documents/xyz.pdf?folder=rider-docs)
            if (url.includes('/api/rider/documents/')) {
                const urlObj = new URL(url, 'http://localhost');
                const filename = urlObj.pathname.split('/').pop();
                const folder = urlObj.searchParams.get('folder') || 'temp';
                return path.posix.join(folder, filename);
            }

            return null;
        } catch (e) {
            return null;
        }
    }
};
