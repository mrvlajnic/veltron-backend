require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const sanitizeHtml = require('sanitize-html');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');

// Ensure uploads folder exists
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(cors({
  origin: [
    'https://veltroncars.com',
    'https://www.veltroncars.com',
    'https://journal.veltroncars.com',
    'https://veltron-backend.onrender.com',
    'http://localhost:5000',
    'http://127.0.0.1:5000'
  ],
  credentials: true
}));
app.use(helmet({
  contentSecurityPolicy: false,  // Disabled because admin panel uses inline scripts/styles
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ==========================================================================
// SSR: JOURNAL (Rendered HTML)
// ==========================================================================
function escapeHtml(str) {
    return String(str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

app.get('/sitemap.xml', async (req, res, next) => {
    const host = req.hostname || '';
    if (host === 'journal.veltroncars.com' || host === 'localhost' || host.includes('onrender')) {
        try {
            const posts = await db.JournalPost.find({ status: 'published' }).sort({ created_at: -1 });
            
            let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
            xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
            
            // Add root journal page
            xml += '  <url>\n';
            xml += '    <loc>https://journal.veltroncars.com/</loc>\n';
            xml += '    <changefreq>daily</changefreq>\n';
            xml += '    <priority>1.0</priority>\n';
            xml += '  </url>\n';
            
            // Add individual posts
            posts.forEach(post => {
                xml += '  <url>\n';
                xml += `    <loc>https://journal.veltroncars.com/${post.slug}</loc>\n`;
                xml += `    <lastmod>${new Date(post.created_at).toISOString()}</lastmod>\n`;
                xml += '    <changefreq>monthly</changefreq>\n';
                xml += '    <priority>0.8</priority>\n';
                xml += '  </url>\n';
            });
            
            xml += '</urlset>';
            
            res.header('Content-Type', 'application/xml');
            return res.send(xml);
        } catch(err) {
            console.error("Sitemap Error:", err);
            return res.status(500).send("Error generating sitemap.");
        }
    }
    next();
});

app.get('/', async (req, res, next) => {
    // Only serve SSR if the request is for the journal subdomain (or local dev)
    const host = req.hostname || '';
    if (host === 'journal.veltroncars.com' || host === 'localhost' || host.includes('onrender')) {
        try {
            const posts = await db.JournalPost.find({ status: 'published' }).sort({ created_at: -1 });
            let template = fs.readFileSync(path.join(__dirname, 'views/journal.html'), 'utf-8');
            
            const meta = `
    <title>Veltron Journal | Automotive Design, Technology & Motion</title>
    <meta name="description" content="Explore official news, design deep-dives, and engineering releases from Veltron Auto.">
            `;
            template = template.replace('<!-- INJECT_META -->', meta);
            template = template.replace('<!-- INJECT_GRID_STYLE -->', 'display: grid;');
            template = template.replace('<!-- INJECT_FILTERS_STYLE -->', 'display: flex;');
            template = template.replace('<!-- INJECT_HERO_STYLE -->', 'display: block;');
            template = template.replace('<!-- INJECT_ARTICLE_READER -->', '');

            let cardsHtml = posts.map(article => {
                let img = article.cover_image || 'https://veltroncars.com/Assets/img/Render2.webp';
                if (img.startsWith('/uploads')) img = `${req.protocol}://${req.get('host')}${img}`;
                
                return `
                <a href="/${article.slug}" class="journal-item-card" style="text-decoration: none; color: inherit; display: flex; flex-direction: column;">
                    <div class="journal-item-cover-wrapper">
                        <img src="${img}" alt="${escapeHtml(article.title)}" class="journal-item-cover" loading="lazy" decoding="async">
                    </div>
                    <div class="journal-item-content">
                        <div class="journal-item-meta">
                            <span class="journal-cat-badge">${escapeHtml(article.category || 'Release')}</span>
                            <span class="journal-item-date">${new Date(article.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                        </div>
                        <h2 class="journal-item-title">${escapeHtml(article.title)}</h2>
                        <p class="journal-item-summary">${escapeHtml(article.summary || '')}</p>
                        <div class="journal-read-link">
                            Read Story <span>→</span>
                        </div>
                    </div>
                </a>
                `;
            }).join('');
            
            if (posts.length === 0) {
                cardsHtml = '<div style="grid-column: 1 / -1; text-align: center; padding: 60px 20px; color: #888;">No releases available.</div>';
            }
            
            template = template.replace('<!-- INJECT_CARDS -->', cardsHtml);
            return res.send(template);
        } catch(err) {
            console.error("SSR Error:", err);
            return res.status(500).send("Error rendering journal.");
        }
    }
    next();
});

app.get('/:slug', async (req, res, next) => {
    const host = req.hostname || '';
    if (host === 'journal.veltroncars.com' || host === 'localhost' || host.includes('onrender')) {
        // Skip API or static paths
        if (req.params.slug.startsWith('api') || req.params.slug.startsWith('uploads') || req.params.slug.startsWith('admin')) return next();
        
        try {
            const post = await db.JournalPost.findOne({ slug: req.params.slug });
            if (!post || (post.status !== 'published')) {
                return next(); // pass to 404
            }
            
            let template = fs.readFileSync(path.join(__dirname, 'views/journal.html'), 'utf-8');
            
            let img = post.cover_image || 'https://veltroncars.com/Assets/img/Render2.webp';
            if (img.startsWith('/uploads')) img = `${req.protocol}://${req.get('host')}${img}`;
            
            const meta = `
    <title>${escapeHtml(post.title)} | Veltron Journal</title>
    <meta name="description" content="${escapeHtml(post.summary)}">
    <meta property="og:title" content="${escapeHtml(post.title)}">
    <meta property="og:description" content="${escapeHtml(post.summary)}">
    <meta property="og:image" content="${img}">
    <meta name="twitter:title" content="${escapeHtml(post.title)}">
    <meta name="twitter:description" content="${escapeHtml(post.summary)}">
    <meta name="twitter:image" content="${img}">
            `;
            template = template.replace('<!-- INJECT_META -->', meta);
            template = template.replace('<!-- INJECT_GRID_STYLE -->', 'display: none;');
            template = template.replace('<!-- INJECT_FILTERS_STYLE -->', 'display: none;');
            template = template.replace('<!-- INJECT_HERO_STYLE -->', 'display: none;');
            template = template.replace('<!-- INJECT_CARDS -->', '');
            
            let content = post.content || '';
            content = sanitizeHtml(content, {
              allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'h3', 'figure', 'figcaption', 'iframe']),
              allowedAttributes: {
                ...sanitizeHtml.defaults.allowedAttributes,
                img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding', 'class', 'style'],
                iframe: ['src', 'width', 'height', 'frameborder', 'allowfullscreen'],
                '*': ['class', 'style']
              },
              allowedSchemes: ['http', 'https', 'data']
            });
            content = content.replace(/\/uploads\//g, `${req.protocol}://${req.get('host')}/uploads/`);
            
            let imgDisplay = post.cover_image ? 'block' : 'none';
            
            const readerHtml = `
            <article class="article-reader" id="article-reader" style="display: block;">
                <a href="/" class="btn-back-journal" style="text-decoration:none; display:inline-block; margin-bottom: 20px;">← Back to all releases</a>
                <div class="article-header">
                    <span class="journal-cat-badge">${escapeHtml(post.category || 'Release').toUpperCase()}</span>
                    <h1 class="article-title">${escapeHtml(post.title)}</h1>
                    <div class="article-byline">
                        <span>By <strong style="color: #fff;">${escapeHtml(post.author || 'Boris Vlajnić')}</strong></span>
                        <span>•</span>
                        <span>${new Date(post.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                    </div>
                </div>
                <img class="article-featured-img" src="${img}" style="display: ${imgDisplay};">
                <div class="article-content-body">${content}</div>
                <div style="margin-top: 50px; padding-top: 30px; border-top: 1px solid #222;">
                    <a href="/" class="btn-back-journal" style="text-decoration:none; display:inline-block;">← Back to all releases</a>
                </div>
            </article>
            `;
            
            template = template.replace('<!-- INJECT_ARTICLE_READER -->', readerHtml);
            return res.send(template);
        } catch(err) {
            console.error("SSR Article Error:", err);
            return res.status(500).send("Error rendering article.");
        }
    }
    next();
});

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
    if (!post || post.status !== 'published') {
      return res.status(404).json({ error: 'Article not found.' });
    }
    res.json(post);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// 🔒 Anti-Brute-Force Rate Limiting for Login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please wait 15 minutes before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
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
const ALLOWED_IMAGE_TYPES = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const MAX_UPLOAD_SIZE = 5 * 1024 * 1024; // 5MB

app.post('/api/admin/upload', authenticateAdmin, (req, res) => {
  const { image, name } = req.body;
  if (!image) return res.status(400).json({ error: 'No image data provided.' });

  try {
    const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ error: 'Invalid base64 image data.' });
    }

    const mimeType = matches[1].toLowerCase();
    const ext = mimeType.split('/')[1] || 'png';

    // Validate file type
    if (!ALLOWED_IMAGE_TYPES.includes(ext)) {
      return res.status(400).json({ error: `File type "${ext}" not allowed. Accepted: ${ALLOWED_IMAGE_TYPES.join(', ')}` });
    }

    const buffer = Buffer.from(matches[2], 'base64');

    // Validate file size
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return res.status(400).json({ error: `File too large. Maximum size: ${MAX_UPLOAD_SIZE / 1024 / 1024}MB` });
    }

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
