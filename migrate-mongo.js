require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const backupPath = path.join(__dirname, 'veltron_data_backup.json');

const migrate = async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('❌ Please set MONGO_URI in your .env file before migrating.');
    process.exit(1);
  }

  if (!fs.existsSync(backupPath)) {
    console.error(`❌ Backup file not found at ${backupPath}`);
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(backupPath, 'utf8');
    const data = JSON.parse(raw);

    console.log('Connecting to MongoDB...');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, family: 4 });
    console.log('✅ Connected to MongoDB');

    console.log('Clearing existing data...');
    await db.Message.deleteMany({});
    await db.JournalPost.deleteMany({});
    await db.User.deleteMany({});

    console.log('Importing Users...');
    if (data.users && data.users.length > 0) {
      const usersToInsert = data.users.map(u => ({
        username: u.username,
        password_hash: u.password_hash,
        role: u.role || 'admin',
        created_at: u.created_at ? new Date(u.created_at) : new Date()
      }));
      await db.User.insertMany(usersToInsert);
    }

    console.log('Importing Journal Posts...');
    if (data.journal_posts && data.journal_posts.length > 0) {
      const postsToInsert = data.journal_posts.map(p => ({
        title: p.title,
        slug: p.slug,
        category: p.category,
        cover_image: p.cover_image,
        summary: p.summary,
        content: p.content,
        author: p.author,
        status: p.status,
        created_at: p.created_at ? new Date(p.created_at) : new Date(),
        updated_at: p.updated_at ? new Date(p.updated_at) : new Date()
      }));
      await db.JournalPost.insertMany(postsToInsert);
    }

    console.log('Importing Messages...');
    if (data.messages && data.messages.length > 0) {
      const messagesToInsert = data.messages.map(m => ({
        name: m.name,
        email: m.email,
        message: m.message,
        status: m.status,
        is_archived: m.is_archived || 0,
        ip_address: m.ip_address,
        archived_at: m.archived_at ? new Date(m.archived_at) : null,
        created_at: m.created_at ? new Date(m.created_at) : new Date()
      }));
      await db.Message.insertMany(messagesToInsert);
    }

    console.log('🎉 Migration completed successfully!');
    process.exit(0);

  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  }
};

migrate();
