const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Serve static frontend, uploads & admin UI
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));

// 🔒 Anti-Bot Rate Limiting
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
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
}

// ==========================================================================
// 1. PUBLIC CONTACT FORM API
// ==========================================================================
app.post('/api/contact', contactLimiter, async (req, res) => {
  const { name, email, message, website_hp } = req.body;

  if (website_hp && website_hp.trim() !== '') {
    console.warn(`🚨 Bot detected via honeypot trap from IP: ${req.ip}`);
    return res.json({ success: true, message: 'Message sent successfully!' });
  }

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

  try {
    const newMessage = await db.Message.create({
      name: name.trim(),
      email: email.trim(),
      message: message.trim(),
      ip_address: clientIp
    });
    console.log(`📩 New message saved [ID: ${newMessage._id}] from ${email}`);
    res.json({ success: true, message: 'Thank you! Your message has been received.' });
  } catch (err) {
    console.error('Database insertion error:', err);
    res.status(500).json({ error: 'Failed to save message. Please try again later.' });
  }
});

app.post('/api/messages', contactLimiter, (req, res) => {
  req.url = '/api/contact';
  app.handle(req, res);
});

// ==========================================================================
// 2. PUBLIC JOURNAL API
// ==========================================================================
app.get('/api/journal', async (req, res) => {
  try {
    const posts = await db.JournalPost.find({ status: 'published' }).sort({ created_at: -1 });
    res.json(posts || []);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/journal/:slug', async (req, res) => {
  try {
    const post = await db.JournalPost.findOne({ slug: req.params.slug });
    if (!post || (post.status !== 'published' && req.query.preview !== 'true')) {
      return res.status(404).json({ error: 'Article not found.' });
    }
    res.json(post);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ==========================================================================
// 3. ADMIN AUTHENTICATION
// ==========================================================================
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const user = await db.User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Invalid credentials.' });

    const isValid = bcrypt.compareSync(password, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Invalid credentials.' });

    const token = jwt.sign(
      { id: user._id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ success: true, token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Login error.' });
  }
});

// ==========================================================================
// 4. ADMIN DASHBOARD & MESSAGES API
// ==========================================================================
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const total = await db.Message.countDocuments();
    const active = await db.Message.countDocuments({ is_archived: 0 });
    const unread = await db.Message.countDocuments({ status: 'unread', is_archived: 0 });
    const archived = await db.Message.countDocuments({ is_archived: 1 });
    const journal_count = await db.JournalPost.countDocuments();

    res.json({
      messages: { total, active, unread, archived },
      journal: { journal_count }
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/messages', authenticateAdmin, async (req, res) => {
  try {
    const rows = await db.Message.find({ is_archived: 0 }).sort({ created_at: -1 });
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/archived', authenticateAdmin, async (req, res) => {
  try {
    const rows = await db.Message.find({ is_archived: 1 }).sort({ archived_at: -1 });
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/messages/:id/archive', authenticateAdmin, async (req, res) => {
  try {
    await db.Message.findByIdAndUpdate(req.params.id, { is_archived: 1, archived_at: new Date() });
    res.json({ success: true, message: 'Message moved to archive.' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/messages/:id/unarchive', authenticateAdmin, async (req, res) => {
  try {
    await db.Message.findByIdAndUpdate(req.params.id, { is_archived: 0, $unset: { archived_at: 1 } });
    res.json({ success: true, message: 'Message restored to inbox.' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/messages/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await db.Message.findByIdAndUpdate(req.params.id, { status: req.body.status || 'read' });
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/messages/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.Message.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Message deleted.' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ==========================================================================
// 5. ADMIN JOURNAL MANAGEMENT API
// ==========================================================================
app.get('/api/admin/journal', authenticateAdmin, async (req, res) => {
  try {
    const rows = await db.JournalPost.find().sort({ created_at: -1 });
    res.json(rows);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/journal/:id', authenticateAdmin, async (req, res) => {
  try {
    const post = await db.JournalPost.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Post not found.' });
    res.json(post);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/journal', authenticateAdmin, async (req, res) => {
  const { title, slug, category, cover_image, summary, content, author, status } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and Content are required.' });

  const postSlug = slug && slug.trim() !== '' 
    ? slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    const post = await db.JournalPost.create({
      title: title.trim(),
      slug: postSlug,
      category: category || 'General',
      cover_image: cover_image || '',
      summary: summary || '',
      content,
      author: author || 'Veltron Team',
      status: status || 'published'
    });
    res.json({ success: true, id: post._id, message: 'Journal article published successfully.' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/journal/:id', authenticateAdmin, async (req, res) => {
  const { title, slug, category, cover_image, summary, content, author, status } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and Content are required.' });

  const postSlug = slug && slug.trim() !== ''
    ? slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-')
    : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  try {
    await db.JournalPost.findByIdAndUpdate(req.params.id, {
      title: title.trim(),
      slug: postSlug,
      category: category || 'General',
      cover_image: cover_image || '',
      summary: summary || '',
      content,
      author: author || 'Veltron Team',
      status: status || 'published'
    });
    res.json({ success: true, message: 'Journal article updated.' });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/journal/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.JournalPost.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Journal article deleted.' });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 📸 Image Upload Endpoint
app.post('/api/admin/upload', authenticateAdmin, (req, res) => {
  const { image, name } = req.body;
  if (!image) return res.status(400).json({ error: 'No image data provided.' });

  try {
    const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: 'Invalid base64 image data.' });
    }

    const ext = matches[1].split('/')[1] || 'png';
    const buffer = Buffer.from(matches[2], 'base64');
    const safeName = (name || 'image').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const filename = `${Date.now()}_${safeName}.${ext}`;
    const filePath = path.join(uploadsDir, filename);

    fs.writeFileSync(filePath, buffer);

    const relativeUrl = `/uploads/${filename}`;
    res.json({ success: true, url: relativeUrl, filename });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to upload image.' });
  }
});

// ==========================================================================
// 6. HEALTH & ROUTING
// ==========================================================================
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', message: 'Veltron Backend is awake & active', timestamp: new Date().toISOString() });
});

app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.get(/^\/admin/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

// ⚡ Self-Ping Keep-Alive System
const https = require('https');
const http = require('http');

function startKeepAlive() {
  const externalUrl = process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) {
    console.log('💡 Local environment detected (RENDER_EXTERNAL_URL not set).');
    return;
  }
  const pingUrl = `${externalUrl}/api/ping`;
  const PING_INTERVAL = 12 * 60 * 1000;
  setInterval(() => {
    const protocol = pingUrl.startsWith('https') ? https : http;
    protocol.get(pingUrl, (res) => {}).on('error', (err) => console.warn('⚠️ Self-ping error:', err.message));
  }, PING_INTERVAL);
}

// Connect to MongoDB, then start server
db.connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Veltron Backend active on http://localhost:${PORT}`);
    console.log(`🔐 Admin Panel: http://localhost:${PORT}/admin`);
    startKeepAlive();
  });
}).catch(err => {
  console.error("Failed to connect to database. Server not started.");
});
