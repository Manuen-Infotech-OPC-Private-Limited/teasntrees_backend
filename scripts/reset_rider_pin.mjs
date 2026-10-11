// Issues a new login PIN to one rider who has forgotten theirs.
//
// PINs are stored bcrypt-hashed, so a forgotten one can't be looked up — it can
// only be replaced. This prints the new PIN once; nothing else records it.
//
//   node scripts/reset_rider_pin.mjs <mobile>
//
// Run it where the .env points at the database you mean to change (the
// production VM for a real rider). It touches exactly one user document and
// refuses to run if the mobile doesn't match exactly one rider.
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

const mobile = (process.argv[2] || '').replace(/\D/g, '').slice(-10);
if (mobile.length !== 10) {
  console.error('usage: node scripts/reset_rider_pin.mjs <10-digit mobile>');
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI);
const users = mongoose.connection.db.collection('users');

const matches = await users
  .find({ mobile, $or: [{ kind: 'Rider' }, { role: 'rider' }] })
  .project({ _id: 1, name: 1, mobile: 1, isApproved: 1 })
  .toArray();

if (matches.length !== 1) {
  console.error(`expected exactly one rider with mobile ${mobile}, found ${matches.length} — nothing changed`);
  await mongoose.disconnect();
  process.exit(1);
}

const rider = matches[0];
const pin = String(crypto.randomInt(1000, 10000));
const hash = await bcrypt.hash(pin, 10);
await users.updateOne({ _id: rider._id }, { $set: { verificationPin: hash } });

console.log(`rider:   ${rider.name ?? '(no name)'} (${rider.mobile}), approved: ${rider.isApproved}`);
console.log(`new PIN: ${pin}`);
await mongoose.disconnect();
