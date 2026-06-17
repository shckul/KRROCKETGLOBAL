const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://your-app.onrender.com';

// База данных
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
    try {
        if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
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
            username: '',
            stats: { total: 0, won: 0, lost: 0 },
        };
        saveDB(db);
    }
    return db.users[userId];
}

app.use(express.json());

// Корень
const indexPath = path.join(__dirname, 'index.html');
app.get('/', (req, res) => res.sendFile(indexPath));
app.use(express.static(__dirname));

// Webhook
app.post('/webhook', async (req, res) => {
    try {
        const body = req.body;
        console.log('=== WEBHOOK ===');
        console.log(JSON.stringify(body).substring(0, 500));

        // Pre-checkout
        if (body.pre_checkout_query) {
            const q = body.pre_checkout_query;
            console.log('Pre-checkout:', q.id, q.invoice_payload);
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pre_checkout_query_id: q.id, ok: true }),
            });
            return res.sendStatus(200);
        }

        // Успешный платёж
        if (body.message?.successful_payment) {
            const payment = body.message.successful_payment;
            const userId = body.message.from.id;
            const amount = payment.total_amount;
            const currency = payment.currency;
            const payload = payment.invoice_payload;

            console.log(`✅ ПЛАТЁЖ: userId=${userId}, amount=${amount}, currency=${currency}, payload=${payload}`);

            // Зачисляем
            const user = getUser(userId);
            user.balance += amount;
            saveDB(db);

            console.log(`💰 Баланс пользователя ${userId}: ${user.balance}`);

            // Сообщение пользователю
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

            // Обновление через WebSocket
            for (const [ws, cd] of clients.entries()) {
                if (cd.userId === userId && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'balance_update', balance: user.balance }));
                    console.log('📡 Баланс отправлен через WS');
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

// API инвойса
app.post('/api/create-invoice', async (req, res) => {
    try {
        const { userId, amount } = req.body;
        console.log(`Создание инвойса: userId=${userId}, amount=${amount}`);

        const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: 'KR ROCKET Пополнение',
                description: `${amount} Stars на баланс`,
                payload: `deposit_${userId}`,
                provider_token: '',
                currency: 'XTR',
                prices: [{ label: `${amount} Stars`, amount: amount }],
            }),
        });

        const data = await response.json();
        console.log('Invoice response:', JSON.stringify(data));

        if (data.ok) {
            res.json({ invoice_link: data.result });
        } else {
            res.status(500).json({ error: data.description || 'Ошибка' });
        }
    } catch (e) {
        res.status(500).json({ error: 'Внутренняя ошибка' });
    }
});

// Здоровье
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', users: Object.keys(db.users).length });
});

// Игровой код
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
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function startRound() {
    if (gameState._timerInterval) clearInterval(gameState._timerInterval);
    if (gameState._multiplierInterval) clearInterval(gameState._multiplierInterval);
    waitingPlayers = [];
    gameState.phase = 'waiting';
    gameState.multiplier = 1.0;
    gameState.crashPoint = generateCrashPoint();
    gameState.timer = 5;
    broadcast({ type: 'round_start', timer: 5 });
    let cd = 5;
    gameState._timerInterval = setInterval(() => {
        cd--;
        gameState.timer = cd;
        broadcast({ type: 'timer_update', timer: cd });
        if (cd <= 0) { clearInterval(gameState._timerInterval);
            startFlight(); }
    }, 1000);
}

function startFlight() {
    gameState.phase = 'flying';
    gameState.multiplier = 1.0;
    gameState.startTime = Date.now();
    broadcast({ type: 'flight_start' });
    gameState._multiplierInterval = setInterval(() => {
        const elapsed = (Date.now() - gameState.startTime) / 1000;
        gameState.multiplier = Math.pow(Math.E, elapsed * 0.08);
        const dm = Math.floor(gameState.multiplier * 100) / 100;
        broadcast({ type: 'multiplier_update', multiplier: dm });
        if (gameState.multiplier >= gameState.crashPoint) { clearInterval(gameState._multiplierInterval);
            doCrash(); }
        if (gameState.multiplier >= 100) { gameState.crashPoint = 100;
            clearInterval(gameState._multiplierInterval);
            doCrash(); }
    }, 80);
}

function doCrash() {
    gameState.phase = 'crashed';
    const fm = gameState.crashPoint < 1.01 ? 1.0 : gameState.crashPoint;
    db.history.unshift({ val: fm, time: Date.now() });
    if (db.history.length > 50) db.history.length = 50;
    waitingPlayers.forEach(p => { if (!p.cashedOut) { getUser(p.userId).stats.lost++; } });
    saveDB(db);
    broadcast({
        type: 'crash',
        crashPoint: fm,
        players: waitingPlayers.map(p => ({
            id: p.userId,
            name: p.name,
            bet: p.bet,
            cashedOut: p.cashedOut || false,
            winAmount: p.winAmount || 0,
        })),
    });
    waitingPlayers = [];
    setTimeout(startRound, 4000);
}

wss.on('connection', (ws) => {
    let cd = { userId: null, name: 'Player', username: '' };
    clients.set(ws, cd);
    ws.send(JSON.stringify({ type: 'init', gameState: { phase: gameState.phase, multiplier: gameState.multiplier, timer: gameState.timer } }));
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            switch (msg.type) {
                case 'auth': {
                    cd.userId = parseInt(msg.userId);
                    cd.name = msg.name || 'Player';
                    cd.username = msg.username || '';
                    const u = getUser(cd.userId);
                    if (msg.name) u.name = msg.name;
                    if (msg.username) u.username = msg.username;
                    saveDB(db);
                    ws.send(JSON.stringify({ type: 'auth_success', balance: u.balance, stats: u.stats }));
                    break;
                }
                case 'place_bet': {
                    if (gameState.phase !== 'waiting') { ws.send(JSON.stringify({ type: 'error', message: 'Ставки закрыты' })); return; }
                    const u = getUser(cd.userId);
                    const a = parseInt(msg.amount);
                    if (!a || a < 10) { ws.send(JSON.stringify({ type: 'error', message: 'Мин. 10 STARS' })); return; }
                    if (a > u.balance) { ws.send(JSON.stringify({ type: 'error', message: 'Мало средств' })); return; }
                    if (waitingPlayers.find(p => p.userId === cd.userId)) { ws.send(JSON.stringify({ type: 'error', message: 'Уже есть ставка' })); return; }
                    u.balance -= a;
                    u.stats.total++;
                    saveDB(db);
                    waitingPlayers.push({ userId: cd.userId, name: cd.name, bet: a, ws, cashedOut: false, winAmount: 0 });
                    ws.send(JSON.stringify({ type: 'bet_accepted', bet: a, balance: u.balance }));
                    broadcast({ type: 'players_update', players: waitingPlayers.map(p => ({ id: p.userId, name: p.name, bet: p.bet })).sort((a, b) => b.bet - a.bet) });
                    break;
                }
                case 'cashout': {
                    if (gameState.phase !== 'flying') { ws.send(JSON.stringify({ type: 'error', message: 'Не время' })); return; }
                    const p = waitingPlayers.find(p => p.userId === cd.userId);
                    if (!p) { ws.send(JSON.stringify({ type: 'error', message: 'Нет ставки' })); return; }
                    if (p.cashedOut) { ws.send(JSON.stringify({ type: 'error', message: 'Уже забрали' })); return; }
                    p.cashedOut = true;
                    const w = Math.floor(p.bet * gameState.multiplier);
                    p.winAmount = w;
                    const u = getUser(cd.userId);
                    u.balance += w;
                    u.stats.won++;
                    saveDB(db);
                    ws.send(JSON.stringify({ type: 'cashout_success', multiplier: Math.floor(gameState.multiplier * 100) / 100, winAmount: w, balance: u.balance }));
                    broadcast({ type: 'player_cashed_out', playerId: cd.userId, playerName: cd.name, multiplier: Math.floor(gameState.multiplier * 100) / 100 });
                    break;
                }
                case 'get_balance': {
                    const u = getUser(cd.userId);
                    ws.send(JSON.stringify({ type: 'balance_update', balance: u.balance }));
                    break;
                }
                case 'withdraw_request': {
                    const userId = msg.userId;
                    const amount = parseInt(msg.amount);
                    const username = msg.username || 'Player';

                    if (!userId || !amount || amount < 100) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Мин. вывод: 100 STARS' }));
                        return;
                    }

                    const u = getUser(userId);
                    if (amount > u.balance) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Недостаточно средств' }));
                        return;
                    }

                    u.balance -= amount;
                    saveDB(db);

                    const withdrawalsFile = path.join(__dirname, 'withdrawals.json');
                    let withdrawals = [];
                    try {
                        if (fs.existsSync(withdrawalsFile)) {
                            withdrawals = JSON.parse(fs.readFileSync(withdrawalsFile, 'utf8'));
                        }
                    } catch (e) {}

                    withdrawals.push({
                        id: Date.now(),
                        userId: userId,
                        username: username,
                        amount: amount,
                        status: 'pending',
                        date: new Date().toISOString(),
                    });

                    fs.writeFileSync(withdrawalsFile, JSON.stringify(withdrawals, null, 2));

                    ws.send(JSON.stringify({
                        type: 'withdraw_success',
                        amount: amount,
                        balance: u.balance,
                    }));

                    console.log(`📤 ВЫВОД: @${username} (ID: ${userId}) - ${amount} STARS`);
                    break;
                }
                case 'admin_set_crash': {
                    const crashPoint = parseFloat(msg.crashPoint);
                    if (!crashPoint || crashPoint < 1) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Неверный X' }));
                        return;
                    }
                    gameState.crashPoint = crashPoint;
                    ws.send(JSON.stringify({ type: 'admin_crash_set', crashPoint: crashPoint }));
                    console.log(`🔧 АДМИН: Следующий краш = ${crashPoint}x`);
                    break;
                }
                case 'admin_add_balance': {
                    const targetUsername = msg.username;
                    const amount = parseInt(msg.amount);
                    if (!targetUsername || !amount || amount < 1) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Неверные данные' }));
                        return;
                    }
                    let found = false;
                    for (const [uid, user] of Object.entries(db.users)) {
                        const userName = (user.username || '').toLowerCase();
                        const userDisplayName = (user.name || '').toLowerCase();
                        const searchName = targetUsername.toLowerCase();
                        
                        if (userName === searchName || userDisplayName === searchName) {
                            user.balance += amount;
                            saveDB(db);
                            
                            // Отправляем обновление админу
                            ws.send(JSON.stringify({
                                type: 'admin_balance_added',
                                amount: amount,
                                targetUsername: user.username || user.name,
                                newBalance: user.balance
                            }));
                            
                            // Если накрученный игрок онлайн — обновляем его баланс
                            for (const [clientWs, clientData] of clients.entries()) {
                                if (clientData.userId === parseInt(uid) && clientWs.readyState === WebSocket.OPEN) {
                                    clientWs.send(JSON.stringify({
                                        type: 'balance_update',
                                        balance: user.balance
                                    }));
                                    break;
                                }
                            }
                            
                            console.log(`💰 АДМИН: +${amount} STARS → @${user.username || user.name} (ID: ${uid}), баланс: ${user.balance}`);
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Игрок @' + targetUsername + ' не найден' }));
                    }
                    break;
                }
            }
        } catch (e) {}
    });
    ws.on('close', () => clients.delete(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Webhook URL: ${WEBHOOK_URL}/webhook`);
    console.log(`Index: ${fs.existsSync(indexPath) ? 'OK' : 'MISSING!'}`);
    startRound();
});
