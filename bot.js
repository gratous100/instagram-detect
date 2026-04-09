const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

let sessions = {};

function setSessions(s) {
  sessions = s;
}

bot.on('callback_query', async (query) => {
  const [action, sessionId] = query.data.split(':');

  if (sessions[sessionId]) {
    sessions[sessionId].status = action;
  }

  await bot.answerCallbackQuery(query.id, {
    text: action === 'accept' ? '✅ Accepted' : '❌ Rejected'
  });

  await bot.editMessageText(
    query.message.text + `\n\n${action === 'accept' ? '✅ Accepted → YouTube' : '❌ Rejected → Instagram'}`,
    { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }
  );
});

async function sendVisitMessage(sessionId, ip, city, region, country) {
  await bot.sendMessage(CHAT_ID, 
    `🔔 *New Visitor*\n\n🌐 IP: \`${ip}\`\n🏙 City: ${city}\n📍 Region: ${region}\n🌍 Country: ${country}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Accept', callback_data: `accept:${sessionId}` },
          { text: '❌ Reject', callback_data: `reject:${sessionId}` }
        ]]
      }
    }
  );
}

module.exports = { sendVisitMessage, setSessions };
