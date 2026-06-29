const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

// ─── App Setup ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'crm-whatsapp-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

// ─── Banco de dados (SQLite local OU PostgreSQL/Supabase) ─────────────────────
let db; // adapter unificado

async function initDB() {
  if (process.env.DATABASE_URL) {
    // ── PostgreSQL (Railway + Supabase) ──
    console.log('Usando PostgreSQL (Supabase)...');
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, name TEXT, is_group BOOLEAN DEFAULT false,
        last_message TEXT, last_message_time BIGINT, unhandled BOOLEAN DEFAULT false,
        updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );
      CREATE TABLE IF NOT EXISTS labels (
        id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, color TEXT NOT NULL DEFAULT '#3b82f6'
      );
      CREATE TABLE IF NOT EXISTS chat_labels (
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY (chat_id, label_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        from_me BOOLEAN DEFAULT false, author TEXT, body TEXT, timestamp BIGINT
      );
    `);

    const seedLabels = [
      ['Urgente','#ef4444'],['Aguardando','#f59e0b'],['Em andamento','#3b82f6'],['Concluído','#10b981']
    ];
    for (const [name, color] of seedLabels) {
      await pool.query('INSERT INTO labels (name,color) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, color]);
    }

    db = {
      async run(sql, params=[]) { await pool.query(pgSql(sql), params); },
      async get(sql, params=[]) { const r = await pool.query(pgSql(sql), params); return r.rows[0]; },
      async all(sql, params=[]) { const r = await pool.query(pgSql(sql), params); return r.rows; },
    };

  } else {
    // ── SQLite local ──
    console.log('Usando SQLite local...');
    const { DatabaseSync } = require('node:sqlite');
    const sqlite = new DatabaseSync('crm.db');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, name TEXT, is_group INTEGER DEFAULT 0,
        last_message TEXT, last_message_time INTEGER, unhandled INTEGER DEFAULT 0,
        updated_at INTEGER DEFAULT (strftime('%s','now'))
      );
      CREATE TABLE IF NOT EXISTS labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, color TEXT NOT NULL DEFAULT '#3b82f6'
      );
      CREATE TABLE IF NOT EXISTS chat_labels (
        chat_id TEXT NOT NULL, label_id INTEGER NOT NULL, PRIMARY KEY (chat_id, label_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, from_me INTEGER DEFAULT 0,
        author TEXT, body TEXT, timestamp INTEGER
      );
    `);
    const seedLabels = [
      ['Urgente','#ef4444'],['Aguardando','#f59e0b'],['Em andamento','#3b82f6'],['Concluído','#10b981']
    ];
    for (const [name, color] of seedLabels) {
      sqlite.prepare('INSERT OR IGNORE INTO labels (name,color) VALUES (?,?)').run(name, color);
    }
    db = {
      async run(sql, params=[]) { sqlite.prepare(sql).run(...params); },
      async get(sql, params=[]) { return sqlite.prepare(sql).get(...params); },
      async all(sql, params=[]) { return sqlite.prepare(sql).all(...params); },
    };
  }
  console.log('Banco de dados pronto.');
}

// Converte ? para $1,$2 (PostgreSQL)
function pgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// ─── Usuários ─────────────────────────────────────────────────────────────────
const SALT = 'crm-salt-2026';
function hashPwd(pwd) { return crypto.createHmac('sha256', SALT).update(pwd).digest('hex'); }

const USERS = [
  { email: 'comercialjuridico1@gmail.com',         hash: hashPwd('comercial2026@'), name: 'Comercial Jurídico' },
  { email: 'comercialjuridicofinanceiro@gmail.com', hash: hashPwd('comercial2026@'), name: 'Financeiro' },
];

// ─── Auth ─────────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
  res.redirect('/login.html');
}

app.get('/login.html', (req, res) => {
  if (req.session?.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const user = USERS.find(u => u.email === email && u.hash === hashPwd(password));
  if (!user) return res.status(401).json({ error: 'Email ou senha incorretos' });
  req.session.user = { email: user.email, name: user.name };
  res.json({ ok: true, name: user.name });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: 'Não autenticado' });
  res.json(req.session.user);
});

app.get('/', requireAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ─── WhatsApp Client ──────────────────────────────────────────────────────────
const wppClient = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.WWEBJS_PATH || './.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process'],
  },
});

let clientReady = false;

wppClient.on('qr', async (qr) => {
  console.log('QR gerado — escaneie no app');
  try { io.emit('qr', await qrcode.toDataURL(qr)); } catch (e) { console.error('Erro QR:', e); }
});

wppClient.on('ready', () => {
  console.log('WhatsApp conectado!');
  clientReady = true;
  io.emit('ready');
  syncChats();
});

wppClient.on('auth_failure', () => io.emit('auth_failure'));
wppClient.on('disconnected', () => { clientReady = false; io.emit('disconnected'); });

wppClient.on('message', async (msg) => {
  const chat = await msg.getChat();
  await upsertChat(chat, msg);
  await db.run(
    'INSERT OR IGNORE INTO messages (id,chat_id,from_me,author,body,timestamp) VALUES (?,?,?,?,?,?)',
    [msg.id._serialized, chat.id._serialized, msg.fromMe ? 1 : 0, msg.author || msg.from, msg.body, msg.timestamp]
  );
  io.emit('message', {
    chatId: chat.id._serialized,
    message: { id: msg.id._serialized, fromMe: msg.fromMe, author: msg.author || msg.from, body: msg.body, timestamp: msg.timestamp },
  });
});

wppClient.initialize();

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function upsertChat(chat, lastMsg = null) {
  await db.run(
    `INSERT INTO chats (id,name,is_group,last_message,last_message_time,updated_at)
     VALUES (?,?,?,?,?,strftime('%s','now'))
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, is_group=excluded.is_group,
       last_message=COALESCE(excluded.last_message,last_message),
       last_message_time=COALESCE(excluded.last_message_time,last_message_time),
       updated_at=strftime('%s','now')`,
    [chat.id._serialized, chat.name, chat.isGroup ? 1 : 0, lastMsg?.body || null, lastMsg?.timestamp || null]
  );
}

async function syncChats() {
  try {
    const chats = await wppClient.getChats();
    for (const c of chats) await upsertChat(c);
    io.emit('chats_synced');
    console.log(`${chats.length} conversas sincronizadas`);
  } catch (e) { console.error('Erro sync:', e); }
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => res.json({ ready: clientReady }));

app.get('/api/chats', async (req, res) => {
  try {
    const { search, label, unhandled, type } = req.query;
    let sql = `SELECT c.*, GROUP_CONCAT(l.id||':'||l.name||':'||l.color,'|') AS labels_raw
      FROM chats c LEFT JOIN chat_labels cl ON cl.chat_id=c.id LEFT JOIN labels l ON l.id=cl.label_id WHERE 1=1`;
    const p = [];
    if (search) { sql += ' AND c.name LIKE ?'; p.push(`%${search}%`); }
    if (unhandled === '1') sql += ' AND c.unhandled=1';
    if (type === 'group') sql += ' AND c.is_group=1';
    else if (type === 'direct') sql += ' AND c.is_group=0';
    if (label) { sql += ' AND cl.label_id=?'; p.push(label); }
    sql += ' GROUP BY c.id ORDER BY c.updated_at DESC';
    const rows = await db.all(sql, p);
    res.json(rows.map(r => ({
      ...r, is_group: !!r.is_group, unhandled: !!r.unhandled,
      labels: r.labels_raw ? r.labels_raw.split('|').map(s => { const [id,name,color]=s.split(':'); return {id:Number(id),name,color}; }) : [],
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/chats/:chatId/messages', async (req, res) => {
  const { chatId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  try {
    const cached = await db.all('SELECT * FROM messages WHERE chat_id=? ORDER BY timestamp DESC LIMIT ?', [chatId, limit]);
    if (cached.length) return res.json(cached.reverse());
    if (!clientReady) return res.status(503).json({ error: 'WhatsApp não conectado' });
    const chat = await wppClient.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit });
    for (const m of msgs) {
      await db.run('INSERT OR IGNORE INTO messages (id,chat_id,from_me,author,body,timestamp) VALUES (?,?,?,?,?,?)',
        [m.id._serialized, chatId, m.fromMe ? 1 : 0, m.author || m.from, m.body, m.timestamp]);
    }
    res.json(msgs.map(m => ({ id: m.id._serialized, chat_id: chatId, from_me: m.fromMe?1:0, author: m.author||m.from, body: m.body, timestamp: m.timestamp })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:chatId/unhandled', async (req, res) => {
  await db.run('UPDATE chats SET unhandled=? WHERE id=?', [req.body.unhandled ? 1 : 0, req.params.chatId]);
  io.emit('chat_updated', { chatId: req.params.chatId });
  res.json({ ok: true });
});

app.get('/api/labels', async (req, res) => res.json(await db.all('SELECT * FROM labels ORDER BY name')));

app.post('/api/labels', async (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    await db.run('INSERT INTO labels (name,color) VALUES (?,?)', [name, color || '#3b82f6']);
    const label = await db.get('SELECT * FROM labels WHERE name=?', [name]);
    res.json(label);
  } catch { res.status(409).json({ error: 'Etiqueta já existe' }); }
});

app.delete('/api/labels/:id', async (req, res) => {
  await db.run('DELETE FROM labels WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/chats/:chatId/labels/:labelId', async (req, res) => {
  await db.run('INSERT OR IGNORE INTO chat_labels (chat_id,label_id) VALUES (?,?)', [req.params.chatId, req.params.labelId]);
  io.emit('chat_updated', { chatId: req.params.chatId });
  res.json({ ok: true });
});

app.delete('/api/chats/:chatId/labels/:labelId', async (req, res) => {
  await db.run('DELETE FROM chat_labels WHERE chat_id=? AND label_id=?', [req.params.chatId, req.params.labelId]);
  io.emit('chat_updated', { chatId: req.params.chatId });
  res.json({ ok: true });
});

app.post('/api/sync', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp não conectado' });
  syncChats();
  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => console.log(`\n🚀 WhatsApp CRM rodando em http://localhost:${PORT}\n`));
}).catch(err => { console.error('Erro banco:', err.message); process.exit(1); });
