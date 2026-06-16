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
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://your-app.onrender.com';

// ====================
// БАЗА ДАННЫХ
// ====================
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) {
            return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Ошибка загрузки БД:', e);
    }
    return { users: {}, history: [] };
}

function saveDB(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
        console.error('Ошибка сохранения БД:', e);
    }
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

// Раздача index.html из корня
const indexPath = path.join(__dirname, 'index.html');
console.log('Index path:', indexPath);
console.log('Index exists:', fs.existsSync(indexPath));

// Корневой маршрут
app.get('/', (req, res) => {
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(500).send('ERROR: index.html not found in root directory');
    }
});

// Раздача статики из корня (для скриптов и стилей если нужно)
app.use(express.static(__dirname));

// Фолбэк
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/webhook')) {
        return res.status(404).json({ error: 'Not found' });
    }
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send('Not found');
    }
});

// ====================
// TELEGRAM WEBHOOK
// ====================
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        console.log('Webhook received');

        if (body.pre_checkout_query) {
            const query = body.pre_checkout_query;
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

        if (body.message && body.message.successful_payment) {
            const payment = body.message.successful_payment;
            const userId = body.message.from.id;
            const amount = payment.total_amount;

            console.log(`Платёж: userId=${userId}, amount=${amount}`);

            const user = updateBalance(userId, amount);

            try {
                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: userId,
                        text: `✅ Пополнение на ${amount} Stars!\nБаланс: ${user.balance} Stars`,
                    }),
                });
            } catch (e) {}

            for (const [ws, clientData] of clients.entries()) {
                if (clientData.userId === userId) {
                    sendTo(ws, { type: 'balance_update', balance: user.balance });
                    break;
                }
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
// API
// ====================
app.post('/api/create-invoice', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        if (!userId || !amount || amount < 1) {
            return res.status(400).json({ error: 'Неверные параметры' });
        }

        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'Пополнение баланса',
                description: `${amount} Stars на баланс KR ROCKET`,
                payload: `deposit_${userId}_${Date.now()}`,
                provider_token: '',
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
        res.status(500).json({ error: 'Внутренняя ошибка' });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', users: Object.keys(db.users).length, history: db.history.length });
});

// ====================
// ХРАНИЛИЩЕ КЛИЕНТОВ
// ====================
const clients = new Map();
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

    console.log('Новый раунд');

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

    db.history.unshift({ val: finalMult, time: Date.now() });
    if (db.history.length > 50) db.history.length = 50;

    waitingPlayers.forEach(p => {
        if (!p.cashedOut) {
            const user = getUser(p.userId);
            user.stats.lost++;
        }
    });
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
                    if (waitingPlayers.find(p => p.userId === userId)) {
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

                    sendTo(ws, { type: 'bet_accepted', bet: betAmount, balance: user.balance });
                    broadcast({
                        type: 'players_update',
                        players: waitingPlayers.map(p => ({ id: p.userId, name: p.name, bet: p.bet })).sort((a, b) => b.bet - a.bet),
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
            console.error('WS error:', e);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
    });
    ws.on('error', () => {
        clients.delete(ws);
    });
});

// ====================
// ЗАПУСК
// ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`KR ROCKET running on port ${PORT}`);
    if (!fs.existsSync(indexPath)) {
        console.error('ВНИМАНИЕ: index.html не найден в корневой папке!');
    }
    startRound();
});
