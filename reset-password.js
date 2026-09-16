require('dotenv').config();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const newPassword = process.argv[2];

if (!newPassword) {
  console.error('❌ Please provide a new password.');
  console.error('Usage: node reset-password.js <new_password>');
  process.exit(1);
}

const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('❌ MONGO_URI is missing. Please set it in your .env file.');
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB Atlas');

    const userSchema = new mongoose.Schema({
      username: String,
      password_hash: String,
      role: String
    });
    const User = mongoose.model('User', userSchema);

    const adminUser = await User.findOne({ username: 'admin' });
    if (!adminUser) {
      console.error('❌ Admin user not found in database. Start the server once to generate it.');
      process.exit(1);
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    adminUser.password_hash = hash;
    await adminUser.save();

    console.log('✅ Password successfully updated for user "admin"!');
    console.log('Restart your Node.js server for the changes to take full effect.');
  } catch (err) {
    console.error('❌ Error updating password:', err.message);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
})();
