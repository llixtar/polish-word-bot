require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- WEB SERVER ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running with CYRILLIC transcription! 🇺🇦'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// --- НАЛАШТУВАННЯ ---
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

const DB_FILE = './brain.json';
const activeSessions = {};

const USER_CONTEXT = `
Ти — вчитель польської мови для українців, які проживають у Польщі.
Твоя мета: допомагати людям вивчати корисні слова для щоденного життя.

ТЕМАТИКА СЛІВ (міксуй різні теми):
- Побут (магазин, дім, їжа).
- Бюрократія (ужонд, документи, пошта).
- Робота та офіс.
- Здоров'я та аптека.
- Ввічливі фрази та сленг.
- Обслуговування авто, назви запчастин та механізмів.
- Сімейні фотосессії.

Задача: Генеруй 3 корисних польських слова у форматі JSON.
`;

// НАЛАШТУВАННЯ КЛАВІАТУРИ
const KEYBOARD = {
    reply_markup: {
        keyboard: [
            ['▶️ Старт', '🛑 Стоп']
        ],
        resize_keyboard: true
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

// --- AI ГЕНЕРАЦІЯ (Оновлений промпт) ---
async function generateWords(usedWords = []) {
    try {
        const ignoreList = usedWords.slice(-50).join(', ');
        
        // 🔥 СУВОРИЙ ПРОМПТ 🔥
        const prompt = `${USER_CONTEXT}
        ЗАВДАННЯ: Згенеруй JSON-масив із 3 (трьох) нових слів (не використовуй: ${ignoreList}).
        
        ВИМОГИ ДО ТРАНСКРИПЦІЇ ("trans"):
        1. Використовуй ТІЛЬКИ українські літери (Кирилицю).
        2. ⛔ ЗАБОРОНЕНО писати латиницею (наприклад, [vdro-że-nie] - ЦЕ ПОМИЛКА).
        3. ✅ ТРЕБА писати кирилицею (наприклад, [вдро-же-нє] - ЦЕ ПРАВИЛЬНО).
        4. Пиши так, як це слово звучить для українця.

        ФОРМАТ ВІДПОВІДІ (тільки чистий JSON):
        [{"word": "Słowo", "trans": "[сло-во]", "translation": "Переклад"}]`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        
        // Шукаємо JSON
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

// --- КОМАНДИ ---
bot.onText(/\/start|▶️ Старт/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (activeSessions[chatId]) {
        activeSessions[chatId].messageTimers.forEach(t => clearTimeout(t));
        clearTimeout(activeSessions[chatId].dailyTimer);
    }
    
    bot.sendMessage(chatId, "🚀 Стартуємо! (Українська транскрипція)", KEYBOARD);

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

    bot.sendMessage(chatId, "🛑 Зупинено. Тисни Старт, коли будеш готовий.", KEYBOARD);
});

console.log('Bot updated with CYRILLIC prompt...');