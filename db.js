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
const defaultPass = process.env.ADMIN_PASSWORD || require('crypto').randomBytes(8).toString('hex');
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
  if (!process.env.ADMIN_PASSWORD) {
    console.log(`⚠️ WARNING: No ADMIN_PASSWORD provided. Auto-generated password: "${defaultPass}"`);
    console.log(`⚠️ Please save this password or set ADMIN_PASSWORD in your .env file.`);
  }
}

// Seed initial journal articles if empty
if (!data.journal_posts || data.journal_posts.length === 0) {
  data.journal_posts = [
    {
      id: data.next_journal_id++,
      title: "Veltron Auto Positioned Alongside Pioneers Yugo and FAP on Autolooks",
      slug: "veltron-auto-autolooks-recognition",
      category: "News",
      cover_image: "https://veltroncars.com/Assets/img/Render2.webp",
      summary: "Autolooks has placed Veltron Auto in the center stage under the Serbian flag alongside historic national automotive legends Yugo and FAP.",
      content: `## A Historic Context for a Next-Generation Vision\n\nVeltron Auto has received prominent recognition on the global automotive platform **Autolooks**, highlighted as an emerging independent automotive brand and R&D studio positioned alongside historic domestic icons **Yugo** and **FAP** under the Serbian flag.\n\n### Defining the Modern Driver's Car\n\nWhile historic manufacturing focused on utilitarian industrial mobility, Veltron represents the contemporary synthesis of **Emotional Aerodynamics**, proprietary **V-Force propulsion**, and intuitive human-centric cockpit software (**SkyUI**).\n\n> "Our goal is not simply to look back at heritage, but to forge forward into the future of automotive styling and mechanical intelligence from our studio in Belgrade."\n\nStay tuned for ongoing developments as our digital engineering and physical validation phases progress.`,
      author: "Boris Vlajnić",
      status: "published",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    },
    {
      id: data.next_journal_id++,
      title: "The Philosophy of Emotional Aerodynamics: Sculpting the V1 SportLine",
      slug: "philosophy-of-emotional-aerodynamics-v1",
      category: "Design",
      cover_image: "https://veltroncars.com/Assets/img/Render2.webp",
      summary: "Exploring how functional airflow channels, athletic sedan proportions, and pure aesthetic emotion converge in the Veltron V1 SportLine.",
      content: `## Form Follows Motion\n\nIn modern vehicle design, aerodynamics is too frequently treated as a sterile mathematical compromise—resulting in generic, interchangeable silhouettes.\n\nWith the **Veltron V1 SportLine**, our design studio set out to prove that drag reduction and downforce management can coexist with striking emotional presence.\n\n### Key Design Highlights\n\n* **Low-slung athletic silhouette:** Balancing high-speed laminar stability with classic sedan elegance.\n* **Integrated functional intakes:** Routing cooling air to powertrain components while sculpting muscular surface tension.\n* **SkyUI seamless cockpit:** An interior crafted to eliminate digital noise and center every control around the driver.\n\n*Read more technical updates in forthcoming Veltron Journal publications.*`,
      author: "Boris Vlajnić",
      status: "published",
      created_at: new Date(Date.now() - 86400000).toISOString(),
      updated_at: new Date(Date.now() - 86400000).toISOString()
    }
  ];
  saveData();
  console.log(`📰 Seeded ${data.journal_posts.length} initial Veltron Journal articles.`);
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
        const [title, slug, category, cover_image, summary, content, author, status] = params;
        const newId = data.next_journal_id++;
        const newPost = {
          id: newId,
          title,
          slug: slug || `post-${newId}`,
          category: category || 'General',
          cover_image: cover_image || '',
          summary: summary || '',
          content: content || '',
          author: author || 'Veltron Team',
          status: status || 'published',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        data.journal_posts.push(newPost);
        saveData();
        const ctx = { lastID: newId, changes: 1 };
        return callback.call(ctx, null);
      }

      // UPDATE journal_posts
      if (sqlLower.includes('update journal_posts set')) {
        const [title, slug, category, cover_image, summary, content, author, status, id] = params;
        const post = data.journal_posts.find(j => j.id == id);
        if (post) {
          if (title !== undefined) post.title = title;
          if (slug !== undefined) post.slug = slug;
          if (category !== undefined) post.category = category;
          if (cover_image !== undefined) post.cover_image = cover_image;
          if (summary !== undefined) post.summary = summary;
          if (content !== undefined) post.content = content;
          if (author !== undefined) post.author = author;
          if (status !== undefined) post.status = status;
          post.updated_at = new Date().toISOString();
          saveData();
        }
        return callback.call({ changes: post ? 1 : 0 }, null);
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

      // SELECT * FROM journal_posts WHERE slug = ?
      if (sqlLower.includes('from journal_posts where slug')) {
        const [slug] = params;
        const post = data.journal_posts.find(j => j.slug === slug);
        return callback(null, post || null);
      }

      // SELECT * FROM journal_posts WHERE id = ?
      if (sqlLower.includes('from journal_posts where id')) {
        const [id] = params;
        const post = data.journal_posts.find(j => j.id == id);
        return callback(null, post || null);
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

      // Public published articles
      if (sqlLower.includes("from journal_posts where status = 'published'")) {
        const list = data.journal_posts
          .filter(j => j.status === 'published')
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        return callback(null, list);
      }

      // All articles for admin
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
