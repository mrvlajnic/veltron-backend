const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const connectDB = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ MONGO_URI is missing. Please set it in your .env file or Render Environment.');
    process.exit(1);
  }
  
  try {
    await mongoose.connect(uri);
    console.log('✅ Connected to MongoDB Atlas');

    // Seed default admin account
    const defaultUser = process.env.ADMIN_USERNAME || 'admin';
    const defaultPass = process.env.ADMIN_PASSWORD || require('crypto').randomBytes(8).toString('hex');
    
    const existingAdmin = await User.findOne({ username: defaultUser });
    if (!existingAdmin) {
      const hash = bcrypt.hashSync(defaultPass, 10);
      await User.create({
        username: defaultUser,
        password_hash: hash,
        role: 'admin'
      });
      console.log(`🔑 Default admin account initialized: username="${defaultUser}"`);
      if (!process.env.ADMIN_PASSWORD) {
        console.log(`⚠️ WARNING: No ADMIN_PASSWORD provided. Auto-generated password: "${defaultPass}"`);
        console.log(`⚠️ Please save this password or set ADMIN_PASSWORD in your .env file.`);
      }
    }
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err);
    process.exit(1);
  }
};

const messageSchema = new mongoose.Schema({
  name: String,
  email: String,
  message: String,
  status: { type: String, default: 'unread' },
  is_archived: { type: Number, default: 0 },
  ip_address: String,
  archived_at: Date
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

// Ensure compatibility with old id-based APIs by adding a virtual 'id' mapping to '_id'
messageSchema.virtual('id').get(function() { return this._id.toHexString(); });
messageSchema.set('toJSON', { virtuals: true });

const journalPostSchema = new mongoose.Schema({
  title: String,
  slug: { type: String, unique: true },
  category: { type: String, default: 'General' },
  cover_image: String,
  summary: String,
  content: String,
  author: { type: String, default: 'Veltron Team' },
  status: { type: String, default: 'published' }
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

journalPostSchema.virtual('id').get(function() { return this._id.toHexString(); });
journalPostSchema.set('toJSON', { virtuals: true });

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password_hash: String,
  role: { type: String, default: 'admin' }
}, { timestamps: { createdAt: 'created_at', updatedAt: false } });

userSchema.virtual('id').get(function() { return this._id.toHexString(); });
userSchema.set('toJSON', { virtuals: true });

const Message = mongoose.model('Message', messageSchema);
const JournalPost = mongoose.model('JournalPost', journalPostSchema);
const User = mongoose.model('User', userSchema);

module.exports = { connectDB, Message, JournalPost, User };
