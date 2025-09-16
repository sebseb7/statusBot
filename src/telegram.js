import TelegramBot from 'node-telegram-bot-api';

let bot;

export function initTelegram(token) {
  bot = new TelegramBot(token, { polling: false });
  return bot;
}

export async function sendMessage(chatId, message) {
  try {
    // Send message without link preview/expansion
    await bot.sendMessage(chatId, message, { 
      parse_mode: 'HTML',
      disable_web_page_preview: true 
    });
  } catch (error) {
    console.error('Failed to send Telegram message:', error.message);
  }
}

export async function sendToAllUsers(message) {
  const chatIds = process.env.TELEGRAM_CHAT_IDS.split(',').map(id => id.trim());
  
  for (const chatId of chatIds) {
    if (chatId) {
      await sendMessage(chatId, message);
    }
  }
}

export async function sendPhoto(chatId, photoPath, caption = '') {
  try {
    await bot.sendPhoto(chatId, photoPath, { 
      caption,
      parse_mode: 'HTML',
      disable_web_page_preview: true 
    });
  } catch (error) {
    console.error('Failed to send photo:', error.message);
  }
}

export function getBot() {
  return bot;
}
