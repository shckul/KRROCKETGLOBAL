const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ====================
// КОНФИГ
// ====================
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE'; // Токен бота из @BotFather
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://your-app.onrender.com'; // URL после деплоя

// ====================
// БАЗА ДАННЫХ (простой JSON)
// ====================
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {}
    return { users: {}, history: [] };
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

function getUser(userId) {
    if (!db.users[userId]) {
        db.users[userId] = {
            id: userId,
            balance: 0,
            name: 'Player',
            stats: { total: 0, won: 0, lost: 0 },
        };
        saveDB(db);
    }
    return db.users[userId];
}

function updateBalance(userId, amount) {
    const user = getUser(userId);
    user.balance += amount;
    saveDB(db);
    return user;
}

// ====================
// MIDDLEWARE
// ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====================
// TELEGRAM WEBHOOK
// ====================
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;

        // Pre-checkout query
        if (body.pre_checkout_query) {
            const query = body.pre_checkout_query;
            // Подтверждаем платёж
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pre_checkout_query_id: query.id,
                    ok: true,
                }),
            });
            return res.sendStatus(200);
        }

        // Успешный платёж
        if (body.message && body.message.successful_payment) {
            const payment = body.message.successful_payment;
            const userId = body.message.from.id;
            const amount = payment.total_amount; // В звездах (целое число)
            const payload = payment.invoice_payload; // 'deposit_USERID'

            console.log(`Платёж от ${userId}: ${amount} Stars, payload: ${payload}`);

            // Зачисляем на баланс
            const user = updateBalance(userId, amount);
            console.log(`Баланс пользователя ${userId}: ${user.balance} Stars`);

            // Отправляем сообщение пользователю
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: userId,
                    text: `✅ Пополнение на ${amount} Stars успешно!\nВаш баланс: ${user.balance} Stars`,
                }),
            });

            // Оповещаем через WebSocket если клиент онлайн
            const client = [...clients.entries()].find(([ws, data]) => data.userId === userId);
            if (client) {
                sendTo(client[0], {
                    type: 'balance_update',
                    balance: user.balance,
                });
            }

            return res.sendStatus(200);
        }

        res.sendStatus(200);
    } catch (e) {
        console.error('Webhook error:', e);
        res.sendStatus(500);
    }
});

// ====================
// API для создания инвойса
// ====================
app.post('/api/create-invoice', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        if (!userId || !amount || amount < 1) {
            return res.status(400).json({ error: 'Неверные параметры' });
        }

        // Создаём инвойс через Telegram API
        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Пополнение баланса',
                description: `${amount} Stars на баланс KR ROCKET`,
                payload: `deposit_${userId}`,
                provider_token: '', // Для Stars пустой
                currency: 'XTR',
                prices: [{ label: `${amount} Stars`, amount: amount }],
            }),
        });

        const data = await response.json();
        if (data.ok) {
            res.json({ invoice_link: data.result });
        } else {
            res.status(500).json({ error: 'Ошибка создания инвойса' });
        }
    } catch (e) {
        console.error('Create invoice error:', e);
        res.status(500).json({ error: 'Внутренняя ошибка' });
    }
});

// ====================
// ХРАНИЛИЩЕ КЛИЕНТОВ
// ====================
const clients = new Map(); // ws -> { userId, name, balance, avatar }
let waitingPlayers = [];
let gameState = {
    phase: 'waiting',
    multiplier: 1.0,
    crashPoint: 1.0,
    timer: 5,
    startTime: null,
    _timerInterval: null,
    _multiplierInterval: null,
};

// ====================
// ГЕНЕРАЦИЯ КРАШ-ПОИНТА
// ====================
function generateCrashPoint() {
    if (Math.random() < 0.08) return 1.0;
    const r = Math.random();
    let cp;
    if (r < 0.55) cp = 1.01 + Math.random() * 0.79;
    else if (r < 0.80) cp = 1.8 + Math.random() * 2.2;
    else if (r < 0.93) cp = 4.0 + Math.random() * 8.0;
    else if (r < 0.98) cp = 12.0 + Math.random() * 18.0;
    else cp = 30.0 + Math.random() * 50.0;
    cp = Math.floor(cp * 100) / 100;
    if (cp < 1.0) cp = 1.0;
    if (cp > 80) cp = 80;
    return cp;
}

// ====================
// РАССЫЛКА
// ====================
function broadcast(data) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(msg);
        }
    });
}

function sendTo(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

// ====================
// ИГРОВОЙ ЦИКЛ
// ====================
function startRound() {
    if (gameState._timerInterval) clearInterval(gameState._timerInterval);
    if (gameState._multiplierInterval) clearInterval(gameState._multiplierInterval);

    waitingPlayers = [];
    gameState.phase = 'waiting';
    gameState.multiplier = 1.0;
    gameState.crashPoint = generateCrashPoint();
    gameState.timer = 5;
    gameState.startTime = null;

    broadcast({ type: 'round_start', timer: gameState.timer });

    let countdown = gameState.timer;
    gameState._timerInterval = setInterval(() => {
        countdown--;
        gameState.timer = countdown;
        broadcast({ type: 'timer_update', timer: countdown });

        if (countdown <= 0) {
            clearInterval(gameState._timerInterval);
            startFlight();
        }
    }, 1000);
}

function startFlight() {
    if (gameState._timerInterval) clearInterval(gameState._timerInterval);

    gameState.phase = 'flying';
    gameState.multiplier = 1.0;
    gameState.startTime = Date.now();

    broadcast({ type: 'flight_start' });

    gameState._multiplierInterval = setInterval(() => {
        const elapsed = (Date.now() - gameState.startTime) / 1000;
        gameState.multiplier = Math.pow(Math.E, elapsed * 0.08);
        const displayMult = Math.floor(gameState.multiplier * 100) / 100;

        broadcast({ type: 'multiplier_update', multiplier: displayMult });

        if (gameState.multiplier >= gameState.crashPoint) {
            clearInterval(gameState._multiplierInterval);
            doCrash();
        }
        if (gameState.multiplier >= 100) {
            gameState.crashPoint = 100;
            clearInterval(gameState._multiplierInterval);
            doCrash();
        }
    }, 80);
}

function doCrash() {
    if (gameState._multiplierInterval) clearInterval(gameState._multiplierInterval);

    gameState.phase = 'crashed';
    const finalMult = gameState.crashPoint < 1.01 ? 1.0 : gameState.crashPoint;

    // Сохраняем в историю
    db.history.unshift({ val: finalMult, time: Date.now() });
    if (db.history.length > 50) db.history.length = 50;
    saveDB(db);

    broadcast({
        type: 'crash',
        crashPoint: finalMult,
        players: waitingPlayers.map(p => ({
            id: p.userId,
            name: p.name,
            bet: p.bet,
            cashedOut: p.cashedOut || false,
            winAmount: p.winAmount || 0,
        })),
    });

    waitingPlayers = [];

    setTimeout(() => startRound(), 4000);
}

// ====================
// WEBSOCKET
// ====================
wss.on('connection', (ws) => {
    console.log('Новое подключение');
    let clientData = { userId: null, name: 'Player', avatar: '' };
    clients.set(ws, clientData);

    sendTo(ws, {
        type: 'init',
        gameState: {
            phase: gameState.phase,
            multiplier: gameState.multiplier,
            timer: gameState.timer,
        },
    });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            const client = clients.get(ws);
            if (!client) return;

            switch (msg.type) {
                case 'auth': {
                    const userId = parseInt(msg.userId);
                    if (!userId) break;

                    client.userId = userId;
                    client.name = msg.name || 'Player';
                    client.avatar = msg.avatar || '';

                    const user = getUser(userId);
                    sendTo(ws, {
                        type: 'auth_success',
                        balance: user.balance,
                        stats: user.stats,
                    });
                    break;
                }

                case 'place_bet': {
                    if (gameState.phase !== 'waiting') {
                        sendTo(ws, { type: 'error', message: 'Ставки не принимаются' });
                        return;
                    }

                    const userId = client.userId;
                    if (!userId) {
                        sendTo(ws, { type: 'error', message: 'Авторизуйтесь' });
                        return;
                    }

                    const betAmount = parseInt(msg.amount);
                    if (!betAmount || betAmount < 10) {
                        sendTo(ws, { type: 'error', message: 'Мин. ставка: 10 STARS' });
                        return;
                    }

                    const user = getUser(userId);
                    if (betAmount > user.balance) {
                        sendTo(ws, { type: 'error', message: 'Недостаточно средств' });
                        return;
                    }

                    const alreadyBet = waitingPlayers.find(p => p.userId === userId);
                    if (alreadyBet) {
                        sendTo(ws, { type: 'error', message: 'Ставка уже сделана' });
                        return;
                    }

                    user.balance -= betAmount;
                    user.stats.total++;
                    saveDB(db);

                    waitingPlayers.push({
                        userId: userId,
                        name: client.name,
                        bet: betAmount,
                        ws: ws,
                        cashedOut: false,
                        winAmount: 0,
                    });

                    sendTo(ws, {
                        type: 'bet_accepted',
                        bet: betAmount,
                        balance: user.balance,
                    });

                    broadcast({
                        type: 'players_update',
                        players: waitingPlayers.map(p => ({
                            id: p.userId,
                            name: p.name,
                            bet: p.bet,
                        })).sort((a, b) => b.bet - a.bet),
                    });
                    break;
                }

                case 'cashout': {
                    if (gameState.phase !== 'flying') {
                        sendTo(ws, { type: 'error', message: 'Не время для кэшаута' });
                        return;
                    }

                    const userId = client.userId;
                    const player = waitingPlayers.find(p => p.userId === userId);
                    if (!player) {
                        sendTo(ws, { type: 'error', message: 'У вас нет активной ставки' });
                        return;
                    }
                    if (player.cashedOut) {
                        sendTo(ws, { type: 'error', message: 'Вы уже забрали' });
                        return;
                    }

                    player.cashedOut = true;
                    const winAmount = Math.floor(player.bet * gameState.multiplier);
                    player.winAmount = winAmount;

                    const user = getUser(userId);
                    user.balance += winAmount;
                    user.stats.won++;
                    saveDB(db);

                    sendTo(ws, {
                        type: 'cashout_success',
                        multiplier: Math.floor(gameState.multiplier * 100) / 100,
                        winAmount: winAmount,
                        balance: user.balance,
                    });

                    broadcast({
                        type: 'player_cashed_out',
                        playerId: userId,
                        playerName: client.name,
                        multiplier: Math.floor(gameState.multiplier * 100) / 100,
                    });
                    break;
                }

                case 'get_balance': {
                    if (client.userId) {
                        const user = getUser(client.userId);
                        sendTo(ws, { type: 'balance_update', balance: user.balance });
                    }
                    break;
                }
            }
        } catch (e) {
            console.error('WS message error:', e);
        }
    });

    ws.on('close', () => {
        console.log('Отключение клиента');
        clients.delete(ws);
    });

    ws.on('error', (err) => {
        console.error('WS error:', err);
        clients.delete(ws);
    });
});

// ====================
// ЗАПУСК
// ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`KR ROCKET server running on port ${PORT}`);
    console.log(`Webhook URL: ${WEBHOOK_URL}/webhook`);
    startRound();
});
