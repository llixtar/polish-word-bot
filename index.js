require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');
const { GoogleGenerativeAI } = require("@google/generative-ai");

// --- WEB SERVER (Для Render) ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running dynamic cycles! 🇵🇱'));
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

// --- НАЛАШТУВАННЯ ---
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

const DB_FILE = './brain.json';

// Зберігаємо таймери тут.
// activeSessions[chatId] = { messageTimers: [], dailyTimer: null }
const activeSessions = {};

const USER_CONTEXT = `
Ти вчитель польської мови. Учень: Андрій (33 роки, Świdnica, Польща).
Інтереси: Full Stack JS, авто Seat Ibiza 2003, син 3.6 роки, побут.
Задача: 3 польських слова JSON.
`;

// --- БАЗА ДАНИХ ---
function loadBrain() {
    if (!fs.existsSync(DB_FILE)) {
        return { users: {} };
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE));
    
    // ЛІКУВАННЯ: Якщо в файлі немає об'єкта users, створюємо його
    if (!data.users) {
        data.users = {};
    }
    
    return data;
}

function saveBrain(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function formatMessage(w) {
    return `🇵🇱 **${w.word}** ${w.trans} - ${w.translation}`;
}

// --- AI ГЕНЕРАЦІЯ (Версія: Кирилична вимова) ---
async function generateWords(usedWords = []) {
    try {
        const ignoreList = usedWords.slice(-50).join(', ');
        
        // ОНОВЛЕНИЙ ПРОМПТ
        const prompt = `${USER_CONTEXT}
        ЗАВДАННЯ:
        Згенеруй JSON-масив із 3 (трьох) нових польських слів.
        Не використовуй слова: ${ignoreList}.
        
        СУВОРІ ВИМОГИ ДО ПОЛІВ:
        1. "word": Польське слово.
        2. "trans": Вимова записана УКРАЇНСЬКИМИ літерами (кирилицею).
           ⛔ ЗАБОРОНЕНО: IPA символи (типу [vdroʒeɲe]).
           ✅ ДОЗВОЛЕНО: Кирилиця (типу [вдроженє], [чешьчь]).
        3. "translation": Переклад українською.

        Приклад правильної відповіді:
        [{"word": "Dziękuję", "trans": "[джєнькує]", "translation": "Дякую"}]

        ВАЖЛИВО: Поверни тільки чистий JSON масив.`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        
        // Витягуємо JSON (на випадок, якщо бот знову захоче поговорити)
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        
        if (!jsonMatch) {
            throw new Error("AI не повернув коректний JSON");
        }

        return JSON.parse(jsonMatch[0]);
    } catch (e) {
        console.error("AI Error:", e.message);
        return null;
    }
}

// --- ЛОГІКА ДИНАМІЧНОГО ЦИКЛУ ---

function startDynamicCycle(chatId) {
    // 1. Перевіряємо, чи юзер ще активний
    const brain = loadBrain();
    const user = brain.users[chatId];
    if (!user || !user.isActive) return;

    // 2. Генеруємо 3 випадкові точки часу в межах 2 годин (120 хв)
    // Час у мілісекундах. Мінімум 1 хвилина затримки, максимум 2 години.
    const maxDuration = 2 * 60 * 60 * 1000; 
    
    // Генеруємо 3 випадкові числа і сортуємо їх (щоб час йшов послідовно)
    const timeDelays = [
        Math.floor(Math.random() * maxDuration) + 10000, 
        Math.floor(Math.random() * maxDuration) + 20000,
        Math.floor(Math.random() * maxDuration) + 30000
    ].sort((a, b) => a - b);

    console.log(`🆕 Новий цикл для ${chatId}. Слова прийдуть через: 
    1) ${(timeDelays[0]/60000).toFixed(1)} хв
    2) ${(timeDelays[1]/60000).toFixed(1)} хв
    3) ${(timeDelays[2]/60000).toFixed(1)} хв (тут буде рестарт)`);

    // Очищаємо масив таймерів для цього чату
    if (!activeSessions[chatId]) activeSessions[chatId] = { messageTimers: [], dailyTimer: null };
    activeSessions[chatId].messageTimers = [];

    // 3. Плануємо відправку
    timeDelays.forEach((delay, index) => {
        const timerId = setTimeout(() => {
            // Читаємо актуальну базу (раптом слова оновилися посеред циклу)
            const currentBrain = loadBrain();
            const currentWords = currentBrain.users[chatId]?.todayWords;

            if (currentWords && currentWords[index]) {
                bot.sendMessage(chatId, formatMessage(currentWords[index]));
            }

            // 🔥 КЛЮЧОВИЙ МОМЕНТ: Якщо це 3-тє слово (index === 2)
            // Ми одразу запускаємо новий цикл, не чекаючи кінця 2 годин!
            if (index === 2) {
                console.log(`🔄 Третє слово надіслано для ${chatId}. Миттєвий рестарт циклу!`);
                startDynamicCycle(chatId);
            }

        }, delay);

        activeSessions[chatId].messageTimers.push(timerId);
    });
}

// Функція оновлення слів раз на 24 години
function scheduleDailyRefresh(chatId) {
    if (!activeSessions[chatId]) activeSessions[chatId] = {};
    
    activeSessions[chatId].dailyTimer = setTimeout(async () => {
        console.log(`📅 24 години минуло. Генерація нових слів для ${chatId}`);
        const brain = loadBrain();
        const user = brain.users[chatId];
        
        if (user && user.isActive) {
            const newWords = await generateWords(user.usedWords);
            if (newWords) {
                user.todayWords = newWords;
                newWords.forEach(w => user.usedWords.push(w.word));
                saveBrain(brain);
                bot.sendMessage(chatId, "☀️ Новий день — нові слова! (Цикл продовжується без зупинки)");
                // Надсилаємо список одразу, щоб юзер бачив, що день оновився
                bot.sendMessage(chatId, newWords.map(formatMessage).join('\n'));
            }
        }
        // Перезапускаємо добовий таймер
        scheduleDailyRefresh(chatId);
    }, 24 * 60 * 60 * 1000);
}

// --- КОМАНДИ ---

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    // Скидання попередніх сесій
    if (activeSessions[chatId]) {
        activeSessions[chatId].messageTimers.forEach(t => clearTimeout(t));
        clearTimeout(activeSessions[chatId].dailyTimer);
    }
    
    bot.sendMessage(chatId, "🚀 Стартуємо! (24h таймер + динамічний цикл)");

    let brain = loadBrain();
    const newWords = await generateWords(brain.users[chatId]?.usedWords || []);

    if (!newWords) return bot.sendMessage(chatId, "AI Error.");

    brain.users[chatId] = {
        isActive: true,
        todayWords: newWords,
        usedWords: (brain.users[chatId]?.usedWords || []).concat(newWords.map(w => w.word))
    };
    saveBrain(brain);

    // 1. Одразу список
    bot.sendMessage(chatId, "Твої слова на цю добу:\n" + newWords.map(formatMessage).join('\n'));

    // 2. Запускаємо логіку
    startDynamicCycle(chatId);     // Запускає "хвилю" повідомлень
    scheduleDailyRefresh(chatId);  // Запускає таймер на 24 години
});

bot.onText(/\/stop/, (msg) => {
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

    bot.sendMessage(chatId, "🛑 Зупинено. До зустрічі!");
});

console.log('Bot is ready...');