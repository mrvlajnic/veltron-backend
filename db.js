const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbFilePath = path.join(__dirname, 'veltron_data.json');

// Data state
let data = {
  messages: [],
  journal_posts: [],
  users: [],
  next_message_id: 1,
  next_journal_id: 1,
  next_user_id: 1
};

// Load existing JSON database
function loadData() {
  if (fs.existsSync(dbFilePath)) {
    try {
      const raw = fs.readFileSync(dbFilePath, 'utf8');
      data = JSON.parse(raw);
    } catch (e) {
      console.error('Error reading DB file, initializing clean state:', e);
    }
  }
}

// Persist JSON database to disk
function saveData() {
  try {
    fs.writeFileSync(dbFilePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving DB file:', e);
  }
}

// Initialize database
loadData();

// Seed default admin account
const defaultUser = process.env.ADMIN_USERNAME || 'admin';
const defaultPass = process.env.ADMIN_PASSWORD || 'veltronadmin2026';
const existingAdmin = data.users.find(u => u.username === defaultUser);

if (!existingAdmin) {
  const hash = bcrypt.hashSync(defaultPass, 10);
  data.users.push({
    id: data.next_user_id++,
    username: defaultUser,
    password_hash: hash,
    role: 'admin',
    created_at: new Date().toISOString()
  });
  saveData();
  console.log(`🔑 Default admin account initialized: username="${defaultUser}"`);
}

// Pure JS Database Engine matching SQLite interface (Zero GLIBC / C++ native dependencies)
const db = {
  serialize: (fn) => { if (fn) fn(); },

  run: function (sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    params = params || [];
    callback = callback || (() => {});

    try {
      const sqlLower = sql.toLowerCase();

      // INSERT INTO messages
      if (sqlLower.includes('insert into messages')) {
        const [name, email, message, ip_address] = params;
        const newId = data.next_message_id++;
        const newMsg = {
          id: newId,
          name,
          email,
          message,
          status: 'unread',
          is_archived: 0,
          ip_address: ip_address || 'unknown',
          created_at: new Date().toISOString(),
          archived_at: null
        };
        data.messages.push(newMsg);
        saveData();
        const ctx = { lastID: newId, changes: 1 };
        return callback.call(ctx, null);
      }

      // UPDATE messages SET is_archived = 1
      if (sqlLower.includes('update messages set is_archived = 1')) {
        const [archived_at, id] = params;
        const msg = data.messages.find(m => m.id == id);
        if (msg) {
          msg.is_archived = 1;
          msg.archived_at = archived_at || new Date().toISOString();
          saveData();
        }
        return callback.call({ changes: msg ? 1 : 0 }, null);
      }

      // UPDATE messages SET is_archived = 0
      if (sqlLower.includes('update messages set is_archived = 0')) {
        const [id] = params;
        const msg = data.messages.find(m => m.id == id);
        if (msg) {
          msg.is_archived = 0;
          msg.archived_at = null;
          saveData();
        }
        return callback.call({ changes: msg ? 1 : 0 }, null);
      }

      // UPDATE messages SET status
      if (sqlLower.includes('update messages set status')) {
        const [status, id] = params;
        const msg = data.messages.find(m => m.id == id);
        if (msg) {
          msg.status = status;
          saveData();
        }
        return callback.call({ changes: msg ? 1 : 0 }, null);
      }

      // DELETE FROM messages
      if (sqlLower.includes('delete from messages')) {
        const [id] = params;
        const initialLen = data.messages.length;
        data.messages = data.messages.filter(m => m.id != id);
        saveData();
        return callback.call({ changes: initialLen - data.messages.length }, null);
      }

      // INSERT INTO journal_posts
      if (sqlLower.includes('insert into journal_posts')) {
        const [title, slug, summary, content, status] = params;
        const newId = data.next_journal_id++;
        const newPost = {
          id: newId,
          title,
          slug,
          summary,
          content,
          author: 'Veltron Team',
          status: status || 'draft',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        data.journal_posts.push(newPost);
        saveData();
        const ctx = { lastID: newId, changes: 1 };
        return callback.call(ctx, null);
      }

      // DELETE FROM journal_posts
      if (sqlLower.includes('delete from journal_posts')) {
        const [id] = params;
        const initialLen = data.journal_posts.length;
        data.journal_posts = data.journal_posts.filter(j => j.id != id);
        saveData();
        return callback.call({ changes: initialLen - data.journal_posts.length }, null);
      }

      callback(null);
    } catch (err) {
      console.error('DB run error:', err);
      callback(err);
    }
  },

  get: function (sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    params = params || [];
    callback = callback || (() => {});

    try {
      const sqlLower = sql.toLowerCase();

      // SELECT * FROM users WHERE username = ?
      if (sqlLower.includes('from users where username')) {
        const [username] = params;
        const user = data.users.find(u => u.username === username);
        return callback(null, user || null);
      }

      // Stats query
      if (sqlLower.includes('count(*) as total')) {
        const active = data.messages.filter(m => !m.is_archived).length;
        const unread = data.messages.filter(m => !m.is_archived && m.status === 'unread').length;
        const archived = data.messages.filter(m => m.is_archived).length;
        return callback(null, {
          total: data.messages.length,
          active,
          unread,
          archived
        });
      }

      if (sqlLower.includes('count(*) as journal_count')) {
        return callback(null, { journal_count: data.journal_posts.length });
      }

      callback(null, null);
    } catch (err) {
      callback(err, null);
    }
  },

  all: function (sql, params, callback) {
    if (typeof params === 'function') {
      callback = params;
      params = [];
    }
    params = params || [];
    callback = callback || (() => {});

    try {
      const sqlLower = sql.toLowerCase();

      if (sqlLower.includes('from messages where is_archived = 0')) {
        const list = data.messages
          .filter(m => !m.is_archived)
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return callback(null, list);
      }

      if (sqlLower.includes('from messages where is_archived = 1')) {
        const list = data.messages
          .filter(m => m.is_archived)
          .sort((a, b) => new Date(b.archived_at || b.created_at) - new Date(a.archived_at || a.created_at));
        return callback(null, list);
      }

      if (sqlLower.includes('from journal_posts')) {
        const list = [...data.journal_posts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return callback(null, list);
      }

      callback(null, []);
    } catch (err) {
      callback(err, []);
    }
  }
};

module.exports = db;
