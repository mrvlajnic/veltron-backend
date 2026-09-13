const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbFilePath = path.join(__dirname, 'veltron_data.json');
const newPassword = process.argv[2];

if (!newPassword) {
  console.error('❌ Please provide a new password.');
  console.error('Usage: node reset-password.js <new_password>');
  process.exit(1);
}

if (!fs.existsSync(dbFilePath)) {
  console.error('❌ Database file not found at', dbFilePath);
  process.exit(1);
}

try {
  const data = JSON.parse(fs.readFileSync(dbFilePath, 'utf8'));
  
  // Assuming 'admin' is the default username
  const adminUser = data.users.find(u => u.username === 'admin');
  
  if (!adminUser) {
    console.error('❌ Admin user not found in the database. Start the server once to generate it.');
    process.exit(1);
  }

  // Hash new password
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(newPassword, salt);
  
  // Update hash
  adminUser.password_hash = hash;
  
  // Save
  fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf8');
  console.log('✅ Password successfully updated for user "admin"!');
  console.log('Restart your Node.js server for the changes to take full effect (if it caches tokens).');

} catch (err) {
  console.error('❌ Error updating password:', err.message);
}
