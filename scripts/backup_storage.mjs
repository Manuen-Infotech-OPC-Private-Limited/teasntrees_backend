// Nightly copy of uploaded files (C:\Storage) to Firebase Storage.
//
// Dish photos, profile pictures, rider documents and delivery proofs live only
// on the VM's disk. This mirrors them to gs://<bucket>/backups/storage/...,
// uploading only files that are new or changed since the last run, so a lost
// VM no longer means lost uploads. Nothing is ever deleted from the backup.
//
//   node scripts/backup_storage.mjs            (run by the TnT-Backup task)
//   node scripts/backup_storage.mjs --dry-run  (list what would be uploaded)
//
// Restore: download the backups/storage/ folder from the Firebase console (or
// `gsutil -m cp -r gs://<bucket>/backups/storage/* C:\Storage\`).
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import admin from '../src/config/firebase.js';

const BUCKET = process.env.BACKUP_BUCKET || 'tnt-lh.firebasestorage.app';
const ROOTS = {
    public: process.env.STORAGE_PUBLIC_PATH || 'C:\\Storage\\public',
    private: process.env.STORAGE_PRIVATE_PATH || 'C:\\Storage\\private',
};
const dryRun = process.argv.includes('--dry-run');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);

const bucket = admin.storage().bucket(BUCKET);
const [exists] = await bucket.exists();
if (!exists) {
    console.error(`Bucket ${BUCKET} not found`);
    process.exit(1);
}

let uploaded = 0, skipped = 0, failed = 0;
for (const [name, root] of Object.entries(ROOTS)) {
    if (!fs.existsSync(root)) continue;
    for (const file of walk(root)) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        const dest = `backups/storage/${name}/${rel}`;
        const stat = fs.statSync(file);
        const stamp = `${stat.size}-${Math.floor(stat.mtimeMs)}`;
        try {
            const remote = bucket.file(dest);
            const [there] = await remote.exists();
            if (there) {
                const [meta] = await remote.getMetadata();
                if (meta.metadata?.source === stamp) { skipped++; continue; }
            }
            if (dryRun) { console.log('would upload', dest); uploaded++; continue; }
            await bucket.upload(file, { destination: dest, metadata: { metadata: { source: stamp } } });
            uploaded++;
        } catch (error) {
            failed++;
            console.error(`failed ${dest}: ${error.message}`);
        }
    }
}
console.log(`${new Date().toISOString()} backup: ${uploaded} uploaded, ${skipped} unchanged, ${failed} failed${dryRun ? ' (dry run)' : ''}`);
process.exit(failed ? 1 : 0);
