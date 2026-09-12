const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'veltron.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Messages Table
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT DEFAULT 'unread',
      is_archived INTEGER DEFAULT 0,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      archived_at DATETIME
    )
  `);

  // Journal Posts Table (for future Journal Management)
  db.run(`
    CREATE TABLE IF NOT EXISTS journal_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      summary TEXT,
      content TEXT NOT NULL,
      author TEXT DEFAULT 'Veltron Team',
      status TEXT DEFAULT 'draft',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Users Table (Admin authentication)
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `, () => {
    // Seed default admin if not exists (username: admin, default password: veltronadmin2026)
    const defaultUser = process.env.ADMIN_USERNAME || 'admin';
    const defaultPass = process.env.ADMIN_PASSWORD || 'veltronadmin2026';

    db.get('SELECT * FROM users WHERE username = ?', [defaultUser], (err, row) => {
      if (!row) {
        const hash = bcrypt.hashSync(defaultPass, 10);
        db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [defaultUser, hash], (err) => {
          if (!err) {
            console.log(`🔑 Default admin created: username="${defaultUser}"`);
          }
        });
      }
    });
  });
});

module.exports = db;
