const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Обязательно включаем парсинг JSON для обработки POST-запросов от инвойсов
app.use(express.json());

// Раздаем статические файлы (наш index.html и ресурсы) из текущей папки
app.use(express.static(path.join(__dirname)));

// --- ГЛОБАЛЬНОЕ СОСТОЯНИЕ ИГРЫ (ОДНО НА ВСЕХ ПОЛЬЗОВАТЕЛЕЙ) ---
const gameState = {
    status: "WAITING", // WAITING, FLYING, CRASHED
    countdown: 5.0,
    multiplier: 1.00,
    crashPoint: 1.00,
    history: [1.45, 2.10, 1.12, 3.40, 1.19], // Стартовая история для красоты
    players: [] // Активные ставки в текущем раунде
};

// --- МАТЕМАТИКА CRASH (ЧЕСТНЫЙ АЛГОРИТМ) ---
function generateCrashPoint() {
    const e = Math.random();
    if (e < 0.03) return 1.00; // 3% шанс мгновенного краша на 1.00x
    return Math.max(1.01, parseFloat((0.97 / (1 - e)).toFixed(2)));
}

// --- ЕДИНЫЙ ИГРОВОЙ ЦИКЛ СЕРВЕРА ---
let elapsed = 0;

function runServerGameLoop() {
    if (gameState.status === "WAITING") {
        gameState.countdown = 5.0;
        gameState.multiplier = 1.00;
        gameState.crashPoint = generateCrashPoint();
        gameState.players = []; // Сбрасываем ставки прошлых игроков

        console.log(`[GAME] Новый раунд. Точка краша определена: ${gameState.crashPoint}x`);

        // Интервал отсчета времени до старта (100мс)
        const countdownInterval = setInterval(() => {
            gameState.countdown -= 0.1;

            // Отправляем тик ожидания всем клиентам
            io.emit('game_tick', {
                status: gameState.status,
                countdown: gameState.countdown,
                multiplier: gameState.multiplier,
                history: gameState.history
            });

            if (gameState.countdown <= 0) {
                clearInterval(countdownInterval);
                gameState.status = "FLYING";
                elapsed = 0;
                runServerGameLoop(); // Переключаемся на цикл полета
            }
        }, 100);

    } else if (gameState.status === "FLYING") {
        // Интервал полета ракетки (40мс для идеальной плавности)
        const flyInterval = setInterval(() => {
            elapsed += 0.04;

            // Медленный, линейно-плавный разгон точки (как на клиенте)
            gameState.multiplier = parseFloat((1.00 + Math.pow(elapsed, 1.3) * 0.25).toFixed(2));

            // Проверяем, достигла ли ракета точки краша
            if (gameState.multiplier >= gameState.crashPoint) {
                gameState.multiplier = gameState.crashPoint;
                clearInterval(flyInterval);

                gameState.status = "CRASHED";
                gameState.history.push(gameState.multiplier);

                // Ограничиваем историю последними 20 раундами
                if (gameState.history.length > 20) {
                    gameState.history.shift();
                }

                console.log(`[GAME] Бум! Краш на коэффициенте ${gameState.multiplier}x`);

                // Отправляем финальный тик краша
                io.emit('game_tick', {
                    status: gameState.status,
                    countdown: 0,
                    multiplier: gameState.multiplier,
                    history: gameState.history
                });

                // Задерживаем состояние краша на 3 секунды перед новым раундом
                setTimeout(() => {
                    gameState.status = "WAITING";
                    runServerGameLoop();
                }, 3000);

            } else {
                // Отправляем текущий коэффициент всем игрокам
                io.emit('game_tick', {
                    status: gameState.status,
                    countdown: 0,
                    multiplier: gameState.multiplier,
                    history: gameState.history
                });
            }
        }, 40);
    }
}

// --- ОБРАБОТКА ПОДКЛЮЧЕНИЙ ВЕБ-СОКЕТОВ ---
io.on('connection', (socket) => {
    console.log(`[SOCKET] Новый клиент подключился: ${socket.id}`);

    // При подключении сразу передаем игроку текущее состояние игры и таблицу ставок
    socket.emit('init_state', gameState);

    // Обработка ставки от пользователя
    socket.on('place_bet', (data) => {
        if (gameState.status !== "WAITING") return; // Ставки принимаются только в фазе ожидания

        // Проверяем, нет ли уже ставки от этого сокета в текущем раунде
        const alreadyBetted = gameState.players.find(p => p.socketId === socket.id);
        if (alreadyBetted) return;

        // Добавляем ставку в глобальный массив раунда
        const newPlayerBet = {
            socketId: socket.id,
            userId: data.userId,
            username: data.username,
            amount: data.amount,
            cashedOut: false,
            winAmount: 0,
            mult: 1.0
        };

        gameState.players.push(newPlayerBet);
        console.log(`[BET] Ставка принята: ${data.username} поставил ${data.amount} звезд`);

        // Рассылаем обновленный список игроков всем клиентам
        io.emit('sync_players', gameState.players);
    });

    // Обработка забирания выигрыша (Cashout)
    socket.on('cashout_bet', () => {
        if (gameState.status !== "FLYING") return; // Забрать деньги можно только во время полета

        const playerBet = gameState.players.find(p => p.socketId === socket.id && !p.cashedOut);
        if (!playerBet) return;

        // Фиксируем текущий коэффициент и рассчитываем сумму выигрыша
        playerBet.cashedOut = true;
        playerBet.mult = gameState.multiplier;
        playerBet.winAmount = Math.floor(playerBet.amount * playerBet.mult);

        console.log(`[CASHOUT] Игрок ${playerBet.username} успешно забрал ${playerBet.winAmount} звезд на ${playerBet.mult}x`);

        // Лично этому пользователю отправляем подтверждение успеха для зачисления на баланс
        socket.emit('cashout_success', {
            winAmount: playerBet.winAmount,
            mult: playerBet.mult
        });

        // Всем остальным синхронизируем таблицу
        io.emit('sync_players', gameState.players);
    });

    socket.on('disconnect', () => {
        console.log(`[SOCKET] Клиент отключился: ${socket.id}`);
    });
});

// --- ЭНДПОИНТ ДЛЯ TELEGRAM STARS (ПЛАТЕЖИ) ---
app.post('/api/create-invoice', async (req, res) => {
    const { userId, amount } = req.body;

    if (!userId || !amount) {
        return res.status(400).json({ error: "Не указаны параметры userId или amount" });
    }

    try {
        const BOT_TOKEN = process.env.BOT_TOKEN || "ТВОЙ_ТОКЕН_БОТА";
        
        const description = `Пополнение баланса KR ROCKET на ${amount} звезд`;
        const payload = `deposit_user_${userId}_${Date.now()}`;
        const currency = "XTR"; 
        const prices = JSON.stringify([{ label: "Telegram Stars", amount: parseInt(amount) }]);

        const telegramUrl = `https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`;
        const response = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: "Пополнение ⭐",
                description: description,
                payload: payload,
                provider_token: "", 
                currency: currency,
                prices: JSON.parse(prices)
            })
        });

        const data = await response.json();

        if (data.ok && data.result) {
            return res.json({ invoiceLink: data.result });
        } else {
            console.error("[TELEGRAM API ERROR]", data);
            return res.status(500).json({ error: "Ошибка Telegram API при создании счета" });
        }

    } catch (error) {
        console.error("[SERVER INVOICE ERROR]", error);
        return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
});

// --- АВТОМАТИЧЕСКОЕ ПОДТВЕРЖДЕНИЕ ПЛАТЕЖЕЙ (LONG POLLING) ---
const BOT_TOKEN = process.env.BOT_TOKEN || "ТВОЙ_ТОКЕН_БОТА";
let lastUpdateId = 0;

async function checkTelegramUpdates() {
    try {
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`);
        const data = await response.json();

        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;

                // 1. Ловим запрос на проверку платежа перед списанием звезд (PreCheckout)
                if (update.pre_checkout_query) {
                    const qId = update.pre_checkout_query.id;
                    console.log(`[PAYMENT] Получен pre_checkout_query для платежа ${qId}. Отправляем подтверждение...`);
                    
                    // Моментально отвечаем Телеграму "ok: true", чтобы убрать колесико загрузки
                    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            pre_checkout_query_id: qId,
                            ok: true
                        })
                    });
                }

                // 2. Ловим финальное уведомление об успешной оплате
                if (update.message && update.message.successful_payment) {
                    const payment = update.message.successful_payment;
                    console.log(`[PAYMENT] Успешная оплата на сумму ${payment.total_amount} ⭐ от пользователя ${update.message.from.id}`);
                }
            }
        }
    } catch (err) {
        // Ошибки таймаута или сети не забивают логи
    }
    // Запускаем бесконечную фоновую проверку заново
    setTimeout(checkTelegramUpdates, 1000);
}

// --- ДЕФОЛТНЫЙ МАРШРУТ ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- ЗАПУСК СЕРВЕРА И ДВИЖОК ИГРЫ ---
server.listen(PORT, () => {
    console.log(`=============================================`);
    console.log(`[SERVER] KR ROCKET запущен на порту: ${PORT}`);
    console.log(`[SERVER] Игровой движок Crash успешно запущен.`);
    console.log(`=============================================`);
    
    runServerGameLoop();
    
    // Запускаем фоновый обработчик платежей Telegram, если токен прописан в Render
    if (BOT_TOKEN !== "ТВОЙ_ТОКЕН_БОТА") {
        console.log(`[SERVER] Служба проверки платежей Stars запущена.`);
        checkTelegramUpdates();
    }
});
