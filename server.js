const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

// ✅ Colors for terminal output
const colors = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  reset: "\x1b[0m",
};

// Middleware
app.use(cors());
app.use(bodyParser.json());

// ✅ Log every request
app.use((req, res, next) => {
  console.log(`${colors.green}🌍 Request:${colors.reset} ${req.method} ${req.url}`);
  next();
});

// ✅ Serve static frontend from /public
app.use(express.static(path.join(__dirname, "../public")));

// Storage
let messages = [];
let archived = [];

// Contact form (save message)
app.post("/contact", (req, res) => {
  const { name, email, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: "All fields are required" });
  }
  const newMessage = {
    id: Date.now(),
    name,
    email,
    message,
    timestamp: new Date().toISOString(),
  };
  messages.push(newMessage);
  console.log(`${colors.green}✅ Message received from:${colors.reset} ${email}`);
  res.json({ success: true, message: "Message saved!", data: newMessage });
});

// Get inbox messages
app.get("/messages", (req, res) => {
  res.json(messages);
});

// Archive message
app.post("/archive/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const index = messages.findIndex((m) => m.id === id);
  if (index === -1) {
    console.log(`${colors.red}❌ Archive failed:${colors.reset} Message not found`);
    return res.status(404).json({ error: "Message not found" });
  }

  const [msg] = messages.splice(index, 1);
  msg.archivedAt = new Date().toISOString();
  archived.push(msg);

  console.log(`${colors.green}📦 Archived message ID:${colors.reset} ${id}`);
  res.json({ success: true, message: "Message archived", data: msg });
});

// Get archived messages
app.get("/archived", (req, res) => {
  res.json(archived);
});

// ✅ Handle 404 (log missing files)
app.use((req, res) => {
  console.log(`${colors.red}❌ Not found:${colors.reset} ${req.method} ${req.url}`);
  res.status(404).send("404 - Page Not Found");
});

// Start server
app.listen(PORT, () => {
  console.log(`${colors.green}✅ Veltron backend + frontend running on http://localhost:${PORT}${colors.reset}`);
});
