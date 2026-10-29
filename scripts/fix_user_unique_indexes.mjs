// Replaces the users collection's `sparse` unique indexes on {mobile, role}
// and {email, role} with partial ones that ignore empty values (see the
// comment above them in src/models/User.js).
//
//   node scripts/fix_user_unique_indexes.mjs            (show what it would do)
//   node scripts/fix_user_unique_indexes.mjs --apply    (do it)
//
// Each new index is built before the old one is dropped, so the rule is never
// off; if real duplicates exist the build fails and nothing is dropped.
import 'dotenv/config';
import mongoose from 'mongoose';

const apply = process.argv.includes('--apply');
await mongoose.connect(process.env.MONGO_URI);
const users = mongoose.connection.db.collection('users');

const wanted = [
    { old: 'mobile_1_role_1', key: { mobile: 1, role: 1 }, name: 'mobile_1_role_1_present', field: 'mobile' },
    { old: 'email_1_role_1', key: { email: 1, role: 1 }, name: 'email_1_role_1_present', field: 'email' },
];

const existing = await users.indexes();
for (const w of wanted) {
    const has = existing.find((i) => i.name === w.name);
    const old = existing.find((i) => i.name === w.old);
    console.log(`${w.field}: partial index ${has ? 'present' : 'missing'}, old sparse index ${old ? 'present' : 'gone'}`);
    if (!apply) continue;
    if (!has) {
        await users.createIndex(w.key, {
            name: w.name,
            unique: true,
            partialFilterExpression: { [w.field]: { $type: 'string' } },
        });
        console.log(`  created ${w.name}`);
    }
    if (old) {
        await users.dropIndex(w.old);
        console.log(`  dropped ${w.old}`);
    }
}
if (!apply) console.log('Dry run. Re-run with --apply to change the indexes.');
await mongoose.disconnect();
process.exit(0);
