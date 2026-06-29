const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { Pool } = require('pg');
const qrcode = require('qrcode');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const OpenAI = require('openai');

// ─── App Setup ───────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'crm-whatsapp-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// ─── Estado global ────────────────────────────────────────────────────────────
let clientReady = false;
let lastQR = null;
let wppClient = null;
let db = null;
let isPostgres = false;
let pgPool = null;

io.on('connection', (socket) => {
  if (clientReady) socket.emit('ready');
  else if (lastQR) socket.emit('qr', lastQR);
});

// ─── DB helpers ───────────────────────────────────────────────────────────────
function pgSql(sql) {
  let i = 0;
  let s = sql.replace(/\?/g, () => `$${++i}`);
  s = s.replace(/INSERT OR IGNORE INTO/gi, 'INSERT INTO');
  if (/INSERT INTO/i.test(s) && !/ON CONFLICT/i.test(s)) {
    s = s.trimEnd();
    if (s.endsWith(')')) s += ' ON CONFLICT DO NOTHING';
  }
  return s;
}
function nowSql() { return isPostgres ? 'EXTRACT(EPOCH FROM NOW())::BIGINT' : "strftime('%s','now')"; }
function boolVal(v) { return isPostgres ? (v ? true : false) : (v ? 1 : 0); }

// ─── PostgreSQL store para RemoteAuth ─────────────────────────────────────────
class PostgresStore {
  async sessionExists({ session }) {
    const r = await pgPool.query('SELECT 1 FROM wwebjs_sessions WHERE name=$1', [session]);
    return r.rowCount > 0;
  }
  async save({ session }) {
    try {
      const zipPath = `RemoteAuth-${session}.zip`;
      if (!fs.existsSync(zipPath)) { console.log('Zip não encontrado:', zipPath); return; }
      const data = fs.readFileSync(zipPath).toString('base64');
      await pgPool.query(
        'INSERT INTO wwebjs_sessions (name,data) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET data=$2, updated_at=NOW()',
        [session, data]
      );
      console.log('Sessão WhatsApp salva no PostgreSQL');
    } catch(e) { console.error('Erro ao salvar sessão:', e.message); }
  }
  async extract({ session, path: destPath }) {
    try {
      const r = await pgPool.query('SELECT data FROM wwebjs_sessions WHERE name=$1', [session]);
      if (!r.rows[0]) { console.log('Nenhuma sessão salva — aguardando QR'); return; }
      fs.writeFileSync(`${destPath}.zip`, Buffer.from(r.rows[0].data, 'base64'));
      console.log('Sessão WhatsApp restaurada do PostgreSQL');
    } catch(e) { console.error('Erro ao extrair sessão:', e.message); }
  }
  async delete({ session }) {
    await pgPool.query('DELETE FROM wwebjs_sessions WHERE name=$1', [session]);
  }
}

// ─── Banco de dados ───────────────────────────────────────────────────────────
async function initDB() {
  if (process.env.DATABASE_URL) {
    console.log('Usando PostgreSQL...');
    pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS wwebjs_sessions (
        name TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, name TEXT, is_group BOOLEAN DEFAULT false,
        last_message TEXT, last_message_time BIGINT, unhandled BOOLEAN DEFAULT false,
        archived BOOLEAN DEFAULT false,
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
        from_me BOOLEAN DEFAULT false, author TEXT, body TEXT, timestamp BIGINT,
        media_type TEXT, media_filename TEXT, media_data TEXT,
        transcription TEXT, summary TEXT
      );
    `);
    await pgPool.query(`ALTER TABLE chats ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false`).catch(() => {});
    await pgPool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_type TEXT`).catch(() => {});
    await pgPool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_filename TEXT`).catch(() => {});
    await pgPool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_data TEXT`).catch(() => {});
    await pgPool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription TEXT`).catch(() => {});
    await pgPool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS summary TEXT`).catch(() => {});

    const seedLabels = [['Urgente','#ef4444'],['Aguardando','#f59e0b'],['Em andamento','#3b82f6'],['Concluído','#10b981']];
    for (const [name, color] of seedLabels) {
      await pgPool.query('INSERT INTO labels (name,color) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [name, color]);
    }

    isPostgres = true;
    db = {
      async run(sql, params=[]) { await pgPool.query(pgSql(sql), params); },
      async get(sql, params=[]) { const r = await pgPool.query(pgSql(sql), params); return r.rows[0]; },
      async all(sql, params=[]) { const r = await pgPool.query(pgSql(sql), params); return r.rows; },
    };
  } else {
    console.log('Usando SQLite local...');
    const { DatabaseSync } = require('node:sqlite');
    const sqlite = new DatabaseSync('crm.db');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, name TEXT, is_group INTEGER DEFAULT 0,
        last_message TEXT, last_message_time INTEGER, unhandled INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
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
        author TEXT, body TEXT, timestamp INTEGER,
        media_type TEXT, media_filename TEXT, media_data TEXT,
        transcription TEXT, summary TEXT
      );
    `);
    const seedLabels = [['Urgente','#ef4444'],['Aguardando','#f59e0b'],['Em andamento','#3b82f6'],['Concluído','#10b981']];
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

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function upsertChat(chat, lastMsg = null) {
  const body = lastMsg?.body || (lastMsg?.hasMedia ? '[mídia]' : null);
  const now = nowSql();
  await db.run(
    `INSERT INTO chats (id,name,is_group,last_message,last_message_time,updated_at)
     VALUES (?,?,?,?,?,${now})
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, is_group=excluded.is_group,
       last_message=COALESCE(excluded.last_message,last_message),
       last_message_time=COALESCE(excluded.last_message_time,last_message_time),
       updated_at=${now}`,
    [chat.id._serialized, chat.name, chat.isGroup ? boolVal(true) : boolVal(false), body, lastMsg?.timestamp || null]
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
app.get('/api/status', (req, res) => res.json({ ready: clientReady, hasOpenAI: !!openai }));

app.get('/api/chats', async (req, res) => {
  try {
    const { search, label, unhandled, type, archived } = req.query;
    const aggFn = isPostgres
      ? `string_agg(l.id::text||':'||l.name||':'||l.color,'|')`
      : `GROUP_CONCAT(l.id||':'||l.name||':'||l.color,'|')`;
    let sql = `SELECT c.*, ${aggFn} AS labels_raw
      FROM chats c LEFT JOIN chat_labels cl ON cl.chat_id=c.id LEFT JOIN labels l ON l.id=cl.label_id WHERE 1=1`;
    const p = [];
    const T = isPostgres ? 'true' : '1';
    const F = isPostgres ? 'false' : '0';
    if (archived === '1') sql += ` AND c.archived=${T}`;
    else sql += ` AND (c.archived=${F} OR c.archived IS NULL)`;
    if (search) { sql += isPostgres ? ' AND c.name ILIKE ?' : ' AND c.name LIKE ?'; p.push(`%${search}%`); }
    if (unhandled === '1') sql += ` AND c.unhandled=${T}`;
    if (type === 'group') sql += ` AND c.is_group=${T}`;
    else if (type === 'direct') sql += ` AND c.is_group=${F}`;
    if (label) { sql += ' AND cl.label_id=?'; p.push(label); }
    sql += ' GROUP BY c.id ORDER BY c.updated_at DESC';
    const rows = await db.all(sql, p);
    res.json(rows.map(r => ({
      ...r, is_group: !!r.is_group, unhandled: !!r.unhandled, archived: !!r.archived,
      labels: r.labels_raw ? r.labels_raw.split('|').map(s => { const [id,name,color]=s.split(':'); return {id:Number(id),name,color}; }) : [],
    })));
  } catch (e) { console.error('Erro /api/chats:', e.message); res.status(500).json({ error: e.message }); }
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
        [m.id._serialized, chatId, m.fromMe ? boolVal(true) : boolVal(false), m.author || m.from, m.body, m.timestamp]);
    }
    res.json(msgs.map(m => ({ id: m.id._serialized, chat_id: chatId, from_me: m.fromMe, author: m.author||m.from, body: m.body, timestamp: m.timestamp })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:chatId/send', async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp não conectado' });
  const { chatId } = req.params;
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensagem vazia' });
  try {
    const sentMsg = await wppClient.sendMessage(chatId, message);
    const ts = Math.floor(Date.now() / 1000);
    await db.run('INSERT OR IGNORE INTO messages (id,chat_id,from_me,body,timestamp) VALUES (?,?,?,?,?)',
      [sentMsg.id._serialized, chatId, boolVal(true), message, ts]);
    await db.run('UPDATE chats SET last_message=?, last_message_time=?, updated_at=? WHERE id=?', [message, ts, ts, chatId]);
    res.json({ ok: true, id: sentMsg.id._serialized });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:chatId/send-media', upload.single('file'), async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'WhatsApp não conectado' });
  const { chatId } = req.params;
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  try {
    const base64 = req.file.buffer.toString('base64');
    const media = new MessageMedia(req.file.mimetype, base64, req.file.originalname);
    const sentMsg = await wppClient.sendMessage(chatId, media, { caption: req.body.caption || '' });
    const ts = Math.floor(Date.now() / 1000);
    const body = req.body.caption || `[${req.file.mimetype.split('/')[0]}]`;
    await db.run('INSERT OR IGNORE INTO messages (id,chat_id,from_me,body,timestamp,media_type,media_filename) VALUES (?,?,?,?,?,?,?)',
      [sentMsg.id._serialized, chatId, boolVal(true), body, ts, req.file.mimetype, req.file.originalname]);
    await db.run('UPDATE chats SET last_message=?, last_message_time=?, updated_at=? WHERE id=?', [body, ts, ts, chatId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages/:msgId/transcribe', async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI não configurado' });
  const { msgId } = req.params;
  try {
    const msg = await db.get('SELECT * FROM messages WHERE id=?', [msgId]);
    if (!msg?.media_data) return res.status(404).json({ error: 'Mídia não encontrada' });
    const audioBuffer = Buffer.from(msg.media_data, 'base64');
    const ext = msg.media_type?.includes('ogg') ? 'ogg' : 'mp3';
    const { toFile } = require('openai');
    const file = await toFile(audioBuffer, `audio.${ext}`, { type: msg.media_type });
    const result = await openai.audio.transcriptions.create({ file, model: 'whisper-1', language: 'pt' });
    const transcription = result.text;
    let summary = null;
    if (transcription.length > 50) {
      const sumResult = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Faça um resumo conciso (máximo 2 linhas) do áudio transcrito.' },
          { role: 'user', content: transcription },
        ],
        max_tokens: 100,
      });
      summary = sumResult.choices[0].message.content;
    }
    await db.run('UPDATE messages SET transcription=?, summary=? WHERE id=?', [transcription, summary, msgId]);
    res.json({ transcription, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/chats/:chatId/unhandled', async (req, res) => {
  await db.run('UPDATE chats SET unhandled=? WHERE id=?', [boolVal(req.body.unhandled), req.params.chatId]);
  io.emit('chat_updated', { chatId: req.params.chatId });
  res.json({ ok: true });
});

app.post('/api/chats/:chatId/archive', async (req, res) => {
  await db.run('UPDATE chats SET archived=? WHERE id=?', [boolVal(req.body.archived), req.params.chatId]);
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

// ─── Inicializar WhatsApp após DB ─────────────────────────────────────────────
function initWhatsApp() {
  const authStrategy = isPostgres
    ? new RemoteAuth({ store: new PostgresStore(), backupSyncIntervalMs: 300000, clientId: 'crm' })
    : new LocalAuth({ dataPath: './.wwebjs_auth' });

  wppClient = new Client({
    authStrategy,
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process','--no-zygote'],
    },
  });

  wppClient.on('qr', async (qr) => {
    console.log('QR gerado — escaneie no app');
    try { lastQR = await qrcode.toDataURL(qr); io.emit('qr', lastQR); } catch (e) {}
  });

  wppClient.on('ready', () => {
    console.log('WhatsApp conectado!');
    clientReady = true; lastQR = null;
    io.emit('ready');
    syncChats();
  });

  wppClient.on('remote_session_saved', () => console.log('Sessão salva no PostgreSQL'));
  wppClient.on('auth_failure', (msg) => { console.error('Auth failure:', msg); io.emit('auth_failure'); });
  wppClient.on('disconnected', (reason) => {
    console.log('WhatsApp desconectado:', reason);
    clientReady = false; io.emit('disconnected');
  });

  wppClient.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      await upsertChat(chat, msg);

      let mediaType = null, mediaFilename = null, mediaData = null, transcription = null, summary = null;

      if (msg.hasMedia) {
        try {
          const media = await msg.downloadMedia();
          mediaType = media.mimetype;
          mediaFilename = media.filename || null;
          if (media.mimetype.startsWith('audio/') || media.mimetype === 'application/ogg') {
            if (openai) {
              try {
                const audioBuffer = Buffer.from(media.data, 'base64');
                const ext = media.mimetype.includes('ogg') ? 'ogg' : 'mp3';
                const { toFile } = require('openai');
                const file = await toFile(audioBuffer, `audio.${ext}`, { type: media.mimetype });
                const result = await openai.audio.transcriptions.create({ file, model: 'whisper-1', language: 'pt' });
                transcription = result.text;
                if (transcription && transcription.length > 50) {
                  const sumResult = await openai.chat.completions.create({
                    model: 'gpt-4o-mini',
                    messages: [
                      { role: 'system', content: 'Faça um resumo conciso (máximo 2 linhas) do áudio transcrito.' },
                      { role: 'user', content: transcription },
                    ],
                    max_tokens: 100,
                  });
                  summary = sumResult.choices[0].message.content;
                }
              } catch (e) { console.error('Erro transcrição:', e.message); }
            }
          } else if (media.data && media.data.length < 2 * 1024 * 1024) {
            mediaData = media.data;
          }
        } catch (e) { console.error('Erro mídia:', e.message); }
      }

      const msgBody = msg.body || (mediaType ? `[${mediaType.split('/')[0]}]` : '');
      await db.run(
        'INSERT OR IGNORE INTO messages (id,chat_id,from_me,author,body,timestamp,media_type,media_filename,media_data,transcription,summary) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [msg.id._serialized, chat.id._serialized, boolVal(msg.fromMe), msg.author || msg.from, msgBody, msg.timestamp, mediaType, mediaFilename, mediaData, transcription, summary]
      );

      io.emit('message', {
        chatId: chat.id._serialized,
        message: { id: msg.id._serialized, fromMe: msg.fromMe, author: msg.author || msg.from, body: msgBody, timestamp: msg.timestamp, mediaType, mediaFilename, transcription, summary },
      });
    } catch(e) { console.error('Erro ao processar mensagem:', e.message); }
  });

  wppClient.initialize();
  console.log('WhatsApp inicializando...');
}

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => console.log(`\n🚀 WhatsApp CRM rodando em http://localhost:${PORT}\n`));
  initWhatsApp();
}).catch(err => { console.error('Erro banco:', err.message); process.exit(1); });
