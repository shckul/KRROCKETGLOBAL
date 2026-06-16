const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Настройка парсинга JSON для работы с платежными инвойсами Telegram
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- БАЗА ДАННЫХ ИГРОКОВ В ПАМЯТИ СЕРВЕРА ---
// В реальном продакшене здесь должна быть MongoDB/PostgreSQL
const usersDatabase = {};

// --- ГЛОБАЛЬНОЕ СОСТОЯНИЕ ИГРЫ (CRASH ENGINE) ---
const gameState = {
    status: "WAITING", // WAITING, FLYING, CRASHED
    countdown: 5.0,
    multiplier: 1.00,
    crashPoint: 1.00,
    history: [1.24, 5.40, 1.00, 2.15, 1.12, 3.80, 1.45, 1.02, 1.90, 1.33],
    players: [] // Текущие ставки в раунде: { id, userId, username, amount, cashedOut, winAmount, mult }
};

// Переменная для отслеживания внутреннего времени полета
let flyElapsedTime = 0;
let gameLoopInterval = null;

// --- МАТЕМАТИКА CRASH (УРЕЗАННЫЕ ШАНСЫ И ЖЁСТКИЙ СЛИВ) ---
function generateCrashPoint() {
    const e = Math.random();
    
    // Повышаем шанс моментального краша на 1.00x с 3% до 8% (слив сразу при старте раунда)
    if (e < 0.08) {
        return 1.00;
    }
    
    // Новая математическая формула: занижаем общие коэффициенты.
    // Теперь высокие иксы (10х+) будут выпадать крайне редко.
    const rawCrash = parseFloat((0.92 / (1 - e)).toFixed(2));
    
    // Искусственный срез: ломаем слишком большие случайные пики
    if (rawCrash > 1.5 && Math.random() < 0.4) {
        // Сливной раунд (каждый третий долетает максимум от 1.01 до 1.41х)
        return parseFloat((1.01 + Math.random() * 0.4).toFixed(2));
    }
    
    return Math.max(1.01, rawCrash);
}

// --- ЕДИНЫЙ ИГРОВОЙ ЦИКЛ СЕРВЕРА ---
function startServerEngine() {
    if (gameLoopInterval) clearInterval(gameLoopInterval);
    
    gameState.status = "WAITING";
    gameState.countdown = 5.0;
    gameState.multiplier = 1.00;
    gameState.players = []; // Очищаем ставки прошлого раунда
    
    console.log(`[GAME] Старт фазы ожидания ставок на 5 секунд...`);
    io.emit('init_state', gameState);

    gameLoopInterval = setInterval(() => {
        if (gameState.status === "WAITING") {
            gameState.countdown -= 0.1;
            
            // Отправляем тики отсчета клиентам
            io.emit('game_tick', {
                status: gameState.status,
                countdown: Math.max(0, gameState.countdown)
            });

            if (gameState.countdown <= 0) {
                // Переходим к полету
                gameState.status = "FLYING";
                gameState.crashPoint = generateCrashPoint();
                flyElapsedTime = 0;
                console.log(`[GAME] Ракета взлетела! Точка краша определена: ${gameState.crashPoint}x`);
            }

        } else if (gameState.status === "FLYING") {
            flyElapsedTime += 0.035; // Уменьшенный шаг времени для медленного и плавного разгона

            // Формула замедленного роста коэффициента (уменьшена степень разгона и множитель)
            gameState.multiplier = parseFloat((1.00 + Math.pow(flyElapsedTime, 1.15) * 0.18).toFixed(2));

            // Проверяем, не достигла ли ракета точки взрыва
            if (gameState.multiplier >= gameState.crashPoint) {
                gameState.multiplier = gameState.crashPoint;
                gameState.status = "CRASHED";
                
                // Добавляем результат в историю и оставляем только последние 10 записей
                gameState.history.push(gameState.multiplier);
                if (gameState.history.length > 10) {
                    gameState.history.shift();
                }

                console.log(`[GAME] Ракета взорвалась на коэффициенте ${gameState.multiplier}x!`);
                io.emit('game_tick', {
                    status: gameState.status,
                    multiplier: gameState.multiplier,
                    history: gameState.history
                });

                // Тайм-аут перед запуском нового раунда (3 секунды на показ экрана краша)
                clearInterval(gameLoopInterval);
                setTimeout(() => {
                    startServerEngine();
                }, 3000);
            } else {
                // Если летит нормально, шлем текущий икс всем игрокам
                io.emit('game_tick', {
                    status: gameState.status,
                    multiplier: gameState.multiplier
                });
            }
        }
    }, 100);
}

// --- API ДЛЯ ПРИЕМА ПЛАТЕЖЕЙ TELEGRAM STARS ---
app.post('/api/create-invoice', (req, res) => {
    const { userId, amount } = req.body;
    if (!userId || !amount) {
        return res.status(400).json({ error: 'Неверные параметры запроса' });
    }

    console.log(`[PAYMENT] Запрос инвойса на пополнение для пользователя ${userId} на сумму ${amount} Stars`);
    
    // ВНИМАНИЕ: Здесь должна быть интеграция с Bot API (метод createInvoice) через ваш токен бота.
    // Пока возвращаем заглушку ссылки для демонстрации интерфейса.
    const mockInvoiceLink = `https://t.me/invoice/mock_stars_payment_${Date.now()}`;
    
    res.json({ invoiceLink: mockInvoiceLink });
});

// Имитация вебхука от Telegram, который сообщает, что юзер реально оплатил звезды
app.post('/api/telegram-payment-webhook', (req, res) => {
    const { userId, amount, status } = req.body;
    
    if (status === 'paid' && userId && amount) {
        if (!usersDatabase[userId]) {
            usersDatabase[userId] = { balance: 0 };
        }
        
        usersDatabase[userId].balance += parseInt(amount);
        console.log(`[PAYMENT] Успешно! Юзеру ${userId} зачислено ${amount} ⭐. Новый баланс: ${usersDatabase[userId].balance}`);
        
        // Моментально пушим обновление баланса подключенному клиенту через веб-сокет
        io.emit('payment_credited', {
            userId: userId,
            newBalance: usersDatabase[userId].balance
        });
        
        return res.json({ success: true });
    }
    res.json({ success: false });
});

// --- ОБРАБОТКА ВЕБ-СОКЕТОВ (SOCKET.IO) ---
io.on('connection', (socket) => {
    let currentSocketUserId = null;
    console.log(`[SOCKET] Новый клиент подключился: ${socket.id}`);

    // Приветственная инициализация состояния игры для нового клиента
    socket.emit('init_state', gameState);

    // Событие авторизации пользователя при входе в игру
    socket.on('auth_user', (data) => {
        const { userId, username } = data;
        if (!userId) return;

        currentSocketUserId = userId;
        
        // Если пользователя нет в базе данных сервера — регистрируем с начальным балансом 100 звезд для теста
        if (!usersDatabase[userId]) {
            usersDatabase[userId] = {
                username: username || `User_${userId}`,
                balance: 100 // Даем приветственный баланс
            };
        }

        console.log(`[AUTH] Игрок ${username} (ID: ${userId}) успешно авторизован. Баланс: ${usersDatabase[userId].balance} ⭐`);
        
        // Отправляем актуальный серверный баланс лично этому игроку
        socket.emit('update_balance', { balance: usersDatabase[userId].balance });
    });

    // Событие ставки от игрока
    socket.on('place_bet', (data) => {
        const { userId, username, amount } = data;
        
        if (gameState.status !== "WAITING") {
            return socket.emit('notification', { text: "Ставки на этот раунд закрыты!" });
        }
        
        if (!usersDatabase[userId] || usersDatabase[userId].balance < amount) {
            return socket.emit('notification', { text: "Недостаточно баланса на сервере!" });
        }

        // Списываем баланс на сервере безопасно
        usersDatabase[userId].balance -= amount;
        
        // Добавляем ставку в игровой раунд
        const newBet = {
            socketId: socket.id,
            userId: userId,
            username: username || "Аноним",
            amount: amount,
            cashedOut: false,
            winAmount: 0,
            mult: 0
        };
        
        gameState.players.push(newBet);
        console.log(`[BET] Ставка принята: ${username} поставил ${amount} ⭐`);

        // Синхронизируем список игроков и обновляем баланс у ставящего
        socket.emit('update_balance', { balance: usersDatabase[userId].balance });
        io.emit('sync_players', gameState.players);
    });

    // Событие нажатия на кнопку "Забрать" (Cashout)
    socket.on('cashout_bet', () => {
        if (gameState.status !== "FLYING") return;

        // Ищем ставку этого конкретного сокета в текущем раунде
        const playerBet = gameState.players.find(p => p.socketId === socket.id && !p.cashedOut);
        
        if (playerBet) {
            playerBet.cashedOut = true;
            playerBet.mult = gameState.multiplier;
            playerBet.winAmount = Math.floor(playerBet.amount * playerBet.mult);

            // Начисляем выигрыш на серверный баланс игрока
            if (usersDatabase[playerBet.userId]) {
                usersDatabase[playerBet.userId].balance += playerBet.winAmount;
            }

            console.log(`[CASHOUT] Игрок ${playerBet.username} забрал ставку на ${playerBet.mult}x и выиграл ${playerBet.winAmount} ⭐`);

            // Отправляем подтверждение успеха клиенту для запуска анимации и haptic-отклика
            socket.emit('cashout_success', {
                winAmount: playerBet.winAmount,
                mult: playerBet.mult
            });

            // Обновляем его баланс и синхронизируем обновленную таблицу участников
            socket.emit('update_balance', { balance: usersDatabase[playerBet.userId].balance });
            io.emit('sync_players', gameState.players);
        }
    });

    // Отключение клиента
    socket.on('disconnect', () => {
        console.log(`[SOCKET] Клиент отключился: ${socket.id}`);
        // ВАЖНО: Мы не удаляем ставку игрока из списка, если он вышел во время полета, 
        // чтобы игра шла честно и его ставка могла «сгореть» или отображаться у других.
    });
});

// Рендеринг главной страницы
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- ЗАПУСК СЕРВЕРА ---
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`[SERVER] KR ROCKET запущен на порту: ${PORT}`);
    console.log(`[SERVER] Ссылка для тестирования: http://localhost:${PORT}`);
    console.log(`==================================================`);
    
    // Запускаем бесконечный игровой цикл казино
    startServerEngine();
});
