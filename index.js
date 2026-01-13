require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- WEB SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running with buttons! 🎮'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// --- НАЛАШТУВАННЯ ---
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

const DB_FILE = './brain.json';
const activeSessions = {};

const USER_CONTEXT = `
Ти вчитель польської мови. Учень: Андрій (33 роки, Świdnica, Польща).
Інтереси: Full Stack JS, авто Seat Ibiza 2003, син 3.6 роки, побут.
Задача: 3 польських слова JSON.
`;

// 🔥 НАЛАШТУВАННЯ КЛАВІАТУРИ (Меню)
const KEYBOARD = {
    reply_markup: {
        keyboard: [
            ['▶️ Старт', '🛑 Стоп'] // Два кнопки в ряд
        ],
        resize_keyboard: true // Щоб кнопки не були на пів екрана
    }
};

// --- БАЗА ДАНИХ ---
function loadBrain() {
    if (!fs.existsSync(DB_FILE)) return { users: {} };
    return JSON.parse(fs.readFileSync(DB_FILE));
}

function saveBrain(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function formatMessage(w) {
    return `🇵🇱 **${w.word}** ${w.trans} - ${w.translation}`;
}

// --- AI ГЕНЕРАЦІЯ ---
async function generateWords(usedWords = []) {
    try {
        const ignoreList = usedWords.slice(-50).join(', ');
        const prompt = `${USER_CONTEXT}
        ЗАВДАННЯ: Згенеруй JSON-масив із 3 нових слів (не використовуй: ${ignoreList}).
        trans - українська транскрипція.
        ВАЖЛИВО: Поверни тільки JSON.
        ФОРМАТ: [{"word": "...", "trans": "[...]", "translation": "..."}]`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("No JSON found");
        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error("AI Error:", e.message);
        return null;
    }
}

// --- ЛОГІКА ДИНАМІЧНОГО ЦИКЛУ ---
function startDynamicCycle(chatId) {
    const brain = loadBrain();
    const user = brain.users[chatId];
    if (!user || !user.isActive) return;

    const maxDuration = 2 * 60 * 60 * 1000; 
    const timeDelays = [
        Math.floor(Math.random() * maxDuration) + 10000, 
        Math.floor(Math.random() * maxDuration) + 20000,
        Math.floor(Math.random() * maxDuration) + 30000
    ].sort((a, b) => a - b);

    if (!activeSessions[chatId]) activeSessions[chatId] = { messageTimers: [], dailyTimer: null };
    activeSessions[chatId].messageTimers = [];

    timeDelays.forEach((delay, index) => {
        const timerId = setTimeout(() => {
            const currentBrain = loadBrain();
            const currentWords = currentBrain.users[chatId]?.todayWords;

            if (currentWords && currentWords[index]) {
                // 🔥 Додаємо KEYBOARD, щоб кнопки не зникали
                bot.sendMessage(chatId, formatMessage(currentWords[index]), KEYBOARD);
            }

            if (index === 2) {
                startDynamicCycle(chatId);
            }
        }, delay);
        activeSessions[chatId].messageTimers.push(timerId);
    });
}

function scheduleDailyRefresh(chatId) {
    if (!activeSessions[chatId]) activeSessions[chatId] = {};
    activeSessions[chatId].dailyTimer = setTimeout(async () => {
        const brain = loadBrain();
        const user = brain.users[chatId];
        if (user && user.isActive) {
            const newWords = await generateWords(user.usedWords);
            if (newWords) {
                user.todayWords = newWords;
                newWords.forEach(w => user.usedWords.push(w.word));
                saveBrain(brain);
                bot.sendMessage(chatId, "☀️ Новий день — нові слова!", KEYBOARD);
                bot.sendMessage(chatId, newWords.map(formatMessage).join('\n'), KEYBOARD);
            }
        }
        scheduleDailyRefresh(chatId);
    }, 24 * 60 * 60 * 1000);
}

// --- КОМАНДИ (Оновлено для кнопок) ---

// 🔥 Тепер реагує на /start АБО на текст "▶️ Старт"
bot.onText(/\/start|▶️ Старт/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (activeSessions[chatId]) {
        activeSessions[chatId].messageTimers.forEach(t => clearTimeout(t));
        clearTimeout(activeSessions[chatId].dailyTimer);
    }
    
    // 🔥 Відправляємо повідомлення РАЗОМ з кнопками (KEYBOARD)
    bot.sendMessage(chatId, "🚀 Стартуємо! Чекай слова.", KEYBOARD);

    let brain = loadBrain();
    const newWords = await generateWords(brain.users[chatId]?.usedWords || []);

    if (!newWords) return bot.sendMessage(chatId, "AI Error.", KEYBOARD);

    brain.users[chatId] = {
        isActive: true,
        todayWords: newWords,
        usedWords: (brain.users[chatId]?.usedWords || []).concat(newWords.map(w => w.word))
    };
    saveBrain(brain);

    bot.sendMessage(chatId, "Твої слова на цю добу:\n" + newWords.map(formatMessage).join('\n'), KEYBOARD);

    startDynamicCycle(chatId);
    scheduleDailyRefresh(chatId);
});

// 🔥 Тепер реагує на /stop АБО на текст "🛑 Стоп"
bot.onText(/\/stop|🛑 Стоп/, (msg) => {
    const chatId = msg.chat.id;
    const brain = loadBrain();

    if (brain.users[chatId]) {
        brain.users[chatId].isActive = false;
        saveBrain(brain);
    }

    if (activeSessions[chatId]) {
        activeSessions[chatId].messageTimers.forEach(t => clearTimeout(t));
        clearTimeout(activeSessions[chatId].dailyTimer);
        delete activeSessions[chatId];
    }

    // 🔥 При зупинці можна приховати клавіатуру або залишити
    // Я залишаю, щоб зручно було натиснути Старт знову
    bot.sendMessage(chatId, "🛑 Зупинено. Тисни Старт, коли будеш готовий.", KEYBOARD);
});

console.log('Bot with buttons started...');