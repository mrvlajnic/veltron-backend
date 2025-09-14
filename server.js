const express = require("express");
const cors = require("cors");
const path = require("path");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// 🔒 Rate limiting (max 3 messages per minute per IP)
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3,
  message: { error: "⏳ Too many requests, slow down please." },
  handler: (req, res, next, options) => {
    console.warn(`⚠️ Flood attempt blocked from IP: ${req.ip}`);
    res.status(429).json(options.message);
  },
});

// Store inbox + archived
let messages = [];
let archived = [];

// ✅ Handle contact form submissions
app.post("/api/messages", messageLimiter, (req, res) => {
  const { name, email, message, honeypot } = req.body;

  // 🕵️ Honeypot trap
  if (honeypot && honeypot.trim() !== "") {
    console.warn("🚨 Bot blocked (honeypot triggered).");
    return res.status(400).json({ error: "Bot detected." });
  }

  // Validation rules
  if (!name || !email || !message) {
    return res.status(400).json({ error: "All fields are required." });
  }
  if (message.length < 5) {
    return res.status(400).json({ error: "Message too short." });
  }
  if (message.length > 1000) {
    return res.status(400).json({ error: "Message too long." });
  }

  const newMsg = {
    id: Date.now(),
    name,
    email,
    message,
    date: new Date().toISOString(),
  };

  messages.push(newMsg);
  console.log("📩 New message received:", newMsg);

  res.json({ success: true, msg: "Message received!" });
});

// ✅ Get inbox
app.get("/api/messages", (req, res) => {
  res.json(messages);
});

// ✅ Archive a message
app.post("/api/archive/:id", (req, res) => {
  const msgId = parseInt(req.params.id, 10);
  const msgIndex = messages.findIndex((m) => m.id === msgId);

  if (msgIndex === -1) {
    return res.status(404).json({ error: "Message not found" });
  }

  const [msg] = messages.splice(msgIndex, 1);
  msg.archivedAt = new Date().toISOString();
  archived.push(msg);

  console.log(`📦 Archived message ${msgId} at ${msg.archivedAt}`);
  res.json({ success: true, archived: msg });
});

// ✅ Get archived messages
app.get("/api/archived", (req, res) => {
  res.json(archived);
});

// ✅ Serve homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// 🌍 Log every request
app.use((req, res, next) => {
  console.log(`🌍 ${req.method} ${req.url}`);
  next();
});

app.listen(PORT, () => {
  console.log(`✅ Veltron backend running on http://localhost:${PORT}`);
});
