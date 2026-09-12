const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'veltron_super_secret_jwt_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend & admin UI
app.use(express.static(path.join(__dirname, 'public')));

// 🔒 Anti-Bot Rate Limiting (max 5 contact submissions per 10 min per IP)
const contactLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Too many contact submissions. Please wait 10 minutes before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 🛡️ Middleware: Verify Admin JWT Token
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }
    req.user = user;
    next();
  });
}

// ==========================================================================
// 1. PUBLIC CONTACT FORM API (Anti-Bot + Rate Limited)
// ==========================================================================
app.post('/api/contact', contactLimiter, (req, res) => {
  const { name, email, message, website_hp } = req.body;

  // 🕵️ Honeypot Trap: If hidden "website_hp" field is filled, silently reject bot!
  if (website_hp && website_hp.trim() !== '') {
    console.warn(`🚨 Bot detected via honeypot trap from IP: ${req.ip}`);
    // Fake success response to trick the bot
    return res.json({ success: true, message: 'Message sent successfully!' });
  }

  // Validation
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Please fill in all required fields (Name, Email, Message).' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  if (message.trim().length < 5) {
    return res.status(400).json({ error: 'Message must be at least 5 characters long.' });
  }

  const clientIp = req.ip || req.headers['x-forwarded-for'] || 'unknown';

  db.run(
    'INSERT INTO messages (name, email, message, ip_address) VALUES (?, ?, ?, ?)',
    [name.trim(), email.trim(), message.trim(), clientIp],
    function (err) {
      if (err) {
        console.error('Database insertion error:', err);
        return res.status(500).json({ error: 'Failed to save message. Please try again later.' });
      }

      console.log(`📩 New message saved [ID: ${this.lastID}] from ${email}`);
      res.json({ success: true, message: 'Thank you! Your message has been received.' });
    }
  );
});

// Alias route for backwards compatibility
app.post('/api/messages', contactLimiter, (req, res) => {
  req.url = '/api/contact';
  app.handle(req, res);
});

// ==========================================================================
// 2. ADMIN AUTHENTICATION
// ==========================================================================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ success: true, token, username: user.username });
  });
});

// ==========================================================================
// 3. ADMIN DASHBOARD API (Protected Routes)
// ==========================================================================

// Dashboard Stats
app.get('/api/admin/stats', authenticateAdmin, (req, res) => {
  db.get(
    `SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN is_archived = 0 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'unread' AND is_archived = 0 THEN 1 ELSE 0 END) as unread,
      SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END) as archived
     FROM messages`,
    (err, msgStats) => {
      if (err) return res.status(500).json({ error: err.message });
      
      db.get('SELECT COUNT(*) as journal_count FROM journal_posts', (err2, journalStats) => {
        res.json({
          messages: msgStats || { total: 0, active: 0, unread: 0, archived: 0 },
          journal: journalStats || { journal_count: 0 }
        });
      });
    }
  );
});

// Get Active Inbox Messages
app.get('/api/admin/messages', authenticateAdmin, (req, res) => {
  db.all('SELECT * FROM messages WHERE is_archived = 0 ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Get Archived Messages
app.get('/api/admin/archived', authenticateAdmin, (req, res) => {
  db.all('SELECT * FROM messages WHERE is_archived = 1 ORDER BY archived_at DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Archive a message
app.post('/api/admin/messages/:id/archive', authenticateAdmin, (req, res) => {
  const { id } = req.params;
  const now = new Date().toISOString();
  db.run('UPDATE messages SET is_archived = 1, archived_at = ? WHERE id = ?', [now, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Message moved to archive.' });
  });
});

// Unarchive a message
app.post('/api/admin/messages/:id/unarchive', authenticateAdmin, (req, res) => {
  const { id } = req.params;
  db.run('UPDATE messages SET is_archived = 0, archived_at = NULL WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Message restored to inbox.' });
  });
});

// Mark message status (e.g. read/replied)
app.post('/api/admin/messages/:id/status', authenticateAdmin, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  db.run('UPDATE messages SET status = ? WHERE id = ?', [status || 'read', id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Delete message
app.delete('/api/admin/messages/:id', authenticateAdmin, (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM messages WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Message deleted.' });
  });
});

// ==========================================================================
// 4. JOURNAL POSTS MANAGEMENT API (Future-Ready)
// ==========================================================================
app.get('/api/admin/journal', authenticateAdmin, (req, res) => {
  db.all('SELECT * FROM journal_posts ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/admin/journal', authenticateAdmin, (req, res) => {
  const { title, slug, summary, content, status } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and Content are required.' });
  }

  const postSlug = slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  db.run(
    'INSERT INTO journal_posts (title, slug, summary, content, status) VALUES (?, ?, ?, ?, ?)',
    [title, postSlug, summary || '', content, status || 'draft'],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID, message: 'Journal post saved.' });
    }
  );
});

app.delete('/api/admin/journal/:id', authenticateAdmin, (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM journal_posts WHERE id = ?', [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Journal post deleted.' });
  });
});

// 🏓 Keep-Alive Health Ping Endpoint
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', message: 'Veltron Backend is awake & active', timestamp: new Date().toISOString() });
});

// Fallback route for Admin SPA
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.get(/^\/admin/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

// ⚡ Self-Ping Keep-Alive System (Prevents Render Free Tier Cold Starts)
const https = require('https');
const http = require('http');

function startKeepAlive() {
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) {
    console.log('💡 Local environment detected (RENDER_EXTERNAL_URL not set).');
    return;
  }

  const pingUrl = `${externalUrl}/api/ping`;
  const PING_INTERVAL = 12 * 60 * 1000; // 12 minutes (Render sleeps after 15m)

  console.log(`⏰ Keep-alive self-ping activated for ${pingUrl} (Every 12 mins)`);

  setInterval(() => {
    const protocol = pingUrl.startsWith('https') ? https : http;
    protocol.get(pingUrl, (res) => {
      console.log(`🏓 Self-ping response: HTTP ${res.statusCode} at ${new Date().toLocaleTimeString()}`);
    }).on('error', (err) => {
      console.warn('⚠️ Self-ping error:', err.message);
    });
  }, PING_INTERVAL);
}

app.listen(PORT, () => {
  console.log(`🚀 Veltron Backend active on http://localhost:${PORT}`);
  console.log(`🔐 Admin Panel: http://localhost:${PORT}/admin`);
  startKeepAlive();
});
