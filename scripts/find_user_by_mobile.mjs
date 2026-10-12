// Shows what accounts exist under a mobile number. Read-only.
//
//   node scripts/find_user_by_mobile.mjs <mobile>
//
// Prints account type, name and approval status only — never the PIN hash.
import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const mobile = (process.argv[2] || '').replace(/\D/g, '').slice(-10);
if (mobile.length !== 10) {
  console.error('usage: node scripts/find_user_by_mobile.mjs <10-digit mobile>');
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI);
const found = await mongoose.connection.db
  .collection('users')
  .find({ mobile: { $regex: mobile } })
  .project({ kind: 1, role: 1, name: 1, mobile: 1, isApproved: 1, brand: 1, createdAt: 1 })
  .toArray();

console.log(found.length ? found : `no account of any kind under ${mobile}`);
await mongoose.disconnect();
