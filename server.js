// Expense splitter: HTTP API + static files on Node's standard library.
// The database is SQLite: a local file in development, a hosted Turso database in production.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createClient } = require('@libsql/client');
const { splitEqually, balances, settle } = require('./settle.js');

const PRODUCTION = process.env.NODE_ENV === 'production';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_SECONDS = 15 * 60;
// Fixed list of files, so a request path can never reach outside public/.
const STATIC = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
};

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS grp (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE);
  CREATE TABLE IF NOT EXISTS members (
    group_id INTEGER NOT NULL REFERENCES grp(id), user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY (group_id, user_id));
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES grp(id),
    paid_by INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL CHECK (amount > 0),
    description TEXT NOT NULL, is_payment INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS shares (
    expense_id INTEGER NOT NULL REFERENCES expenses(id),
    user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL,
    PRIMARY KEY (expense_id, user_id));
`;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// shortcut: scryptSync blocks the server for ~50ms per login, switch to async scrypt if this gets real traffic
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function passwordMatches(password, stored) {
  const expected = Buffer.from(stored);
  const actual = Buffer.from(hashPassword(password, stored.split(':')[0]));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const now = () => Math.floor(Date.now() / 1000);

function text(body, key, max) {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (!value || value.length > max) throw new HttpError(400, `Enter a ${key} (up to ${max} characters)`);
  return value;
}

// "12.50" -> 1250. Parsed as text so no float ever touches the money.
function parsePence(value) {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  const pence = m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0')) : 0;
  if (pence <= 0) throw new HttpError(400, 'Enter an amount like 12.50');
  return pence;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Send JSON'));
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 10000) reject(new HttpError(413, 'Request too large'));
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        if (!body || typeof body !== 'object') throw new Error();
        resolve(body);
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
  });
}

// db: { url, authToken }. url is "file:data.db", ":memory:" or a libsql:// address.
async function createApp(dbConfig) {
  const db = createClient(dbConfig);
  await db.executeMultiple(SCHEMA);
  const all = async (sql, ...args) => (await db.execute({ sql, args })).rows;
  const get = async (sql, ...args) => (await all(sql, ...args))[0];
  const run = (sql, ...args) => db.execute({ sql, args });

  // The cookie holds a random token; the database only stores its hash, so a leaked
  // database can't be used to log in as anyone. Secure is left off locally because
  // browsers only send Secure cookies over https and development runs on http://localhost.
  function setCookie(res, token, maxAge) {
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${PRODUCTION ? '; Secure' : ''}`);
  }
  async function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    await run('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)', sha256(token), userId, now() + SESSION_SECONDS);
    setCookie(res, token, SESSION_SECONDS);
  }
  const sessionToken = (req) => /(?:^|;\s*)sid=([0-9a-f]{64})/.exec(req.headers.cookie || '')?.[1];

  async function currentUser(req) {
    const token = sessionToken(req);
    const user = token && await get(
      'SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?',
      sha256(token), now());
    if (!user) throw new HttpError(401, 'Please log in');
    return { id: user.id, name: user.name };
  }

  // Slows down password guessing: a few wrong tries per address and email, then a wait.
  // shortcut: counts live in memory, so they reset on restart and aren't shared between servers; move to the database if this runs on more than one machine
  const failedLogins = new Map();
  function loginKey(req, email) {
    // behind the host's proxy the real address is in X-Forwarded-For; don't trust that header anywhere else
    const ip = PRODUCTION ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress;
    return `${ip}|${email}`;
  }
  function checkLoginAllowed(key) {
    const entry = failedLogins.get(key);
    if (entry && entry.resetAt <= now()) failedLogins.delete(key);
    else if (entry && entry.count >= LOGIN_ATTEMPTS) throw new HttpError(429, 'Too many wrong tries. Wait 15 minutes and try again.');
  }
  function recordFailedLogin(key) {
    if (failedLogins.size > 10000) failedLogins.clear(); // bound memory under a flood
    const entry = failedLogins.get(key) ?? { count: 0, resetAt: now() + LOGIN_WINDOW_SECONDS };
    entry.count++;
    failedLogins.set(key, entry);
  }

  // 404 rather than 403, so non-members can't tell which group ids exist.
  async function requireMember(groupId, userId) {
    if (!await get('SELECT 1 FROM members WHERE group_id = ? AND user_id = ?', groupId, userId)) {
      throw new HttpError(404, 'Group not found');
    }
  }
  const memberIds = async (groupId) => (await all('SELECT user_id FROM members WHERE group_id = ? ORDER BY user_id', groupId)).map((r) => r.user_id);

  // One batch is one transaction, so an expense can never be saved without its shares.
  // Inside it the new expense is the highest id, which is how the shares find it.
  function insertExpense(groupId, paidBy, amount, description, isPayment, shares) {
    return db.batch([
      {
        sql: 'INSERT INTO expenses (group_id, paid_by, amount, description, is_payment, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [groupId, paidBy, amount, description, isPayment, now()],
      },
      ...shares.map((s) => ({
        sql: 'INSERT INTO shares (expense_id, user_id, amount) VALUES ((SELECT MAX(id) FROM expenses), ?, ?)',
        args: [s.userId, s.amount],
      })),
    ], 'write');
  }

  const routes = [
    ['POST', /^\/api\/register$/, async ({ res, body }) => {
      const name = text(body, 'name', 60);
      const email = text(body, 'email', 200).toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 200) {
        throw new HttpError(400, 'Password must be at least 8 characters');
      }
      if (await get('SELECT 1 FROM users WHERE email = ?', email)) throw new HttpError(409, 'That email is already registered');
      const { lastInsertRowid } = await run('INSERT INTO users (name, email, password) VALUES (?, ?, ?)', name, email, hashPassword(body.password));
      await startSession(res, Number(lastInsertRowid));
    }],

    ['POST', /^\/api\/login$/, async ({ req, res, body }) => {
      const email = String(body.email || '').trim().toLowerCase();
      const key = loginKey(req, email);
      checkLoginAllowed(key);
      const user = await get('SELECT id, password FROM users WHERE email = ?', email);
      if (!user || typeof body.password !== 'string' || !passwordMatches(body.password, user.password)) {
        recordFailedLogin(key);
        throw new HttpError(401, 'Wrong email or password');
      }
      failedLogins.delete(key);
      await startSession(res, user.id);
    }],

    ['POST', /^\/api\/logout$/, async ({ req, res }) => {
      const token = sessionToken(req);
      if (token) await run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
      setCookie(res, '', 0);
    }],

    ['GET', /^\/api\/me$/, async ({ req }) => {
      const user = await currentUser(req);
      const groups = await all('SELECT g.id, g.name FROM grp g JOIN members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.id', user.id);
      return { user, groups: groups.map((g) => ({ id: g.id, name: g.name })) };
    }],

    ['POST', /^\/api\/groups$/, async ({ req, body }) => {
      const user = await currentUser(req);
      const name = text(body, 'name', 60);
      const code = crypto.randomBytes(6).toString('base64url');
      const [created] = await db.batch([
        { sql: 'INSERT INTO grp (name, code) VALUES (?, ?)', args: [name, code] },
        { sql: 'INSERT INTO members (group_id, user_id) VALUES ((SELECT MAX(id) FROM grp), ?)', args: [user.id] },
      ], 'write');
      return { id: Number(created.lastInsertRowid) };
    }],

    ['POST', /^\/api\/groups\/join$/, async ({ req, body }) => {
      const user = await currentUser(req);
      const group = await get('SELECT id FROM grp WHERE code = ?', String(body.code || '').trim());
      if (!group) throw new HttpError(404, 'No group has that invite code');
      await run('INSERT OR IGNORE INTO members (group_id, user_id) VALUES (?, ?)', group.id, user.id);
      return { id: group.id };
    }],

    ['GET', /^\/api\/groups\/(\d+)$/, async ({ req, params: [groupId] }) => {
      const user = await currentUser(req);
      await requireMember(groupId, user.id);
      const [group, memberRows, shareRows, expenseRows] = await Promise.all([
        get('SELECT id, name, code FROM grp WHERE id = ?', groupId),
        all('SELECT u.id, u.name FROM users u JOIN members m ON m.user_id = u.id WHERE m.group_id = ? ORDER BY u.id', groupId),
        all('SELECT s.expense_id, s.user_id, s.amount FROM shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?', groupId),
        all('SELECT id, paid_by, amount, description, is_payment, created_at FROM expenses WHERE group_id = ? ORDER BY id DESC', groupId),
      ]);
      const members = memberRows.map((m) => ({ id: m.id, name: m.name }));
      const expenses = expenseRows.map((e) => ({
        id: e.id, paidBy: e.paid_by, amount: e.amount, description: e.description, isPayment: !!e.is_payment, createdAt: e.created_at,
        shares: shareRows.filter((s) => s.expense_id === e.id).map((s) => ({ userId: s.user_id, amount: s.amount })),
      }));
      const net = balances(members.map((m) => m.id), expenses);
      return {
        group: { id: group.id, name: group.name, code: group.code },
        members, expenses,
        balances: [...net].map(([userId, amount]) => ({ userId, amount })),
        transfers: settle(net),
      };
    }],

    ['POST', /^\/api\/groups\/(\d+)\/expenses$/, async ({ req, body, params: [groupId] }) => {
      const user = await currentUser(req);
      await requireMember(groupId, user.id);
      const description = text(body, 'description', 100);
      const amount = parsePence(body.amount);
      await insertExpense(groupId, user.id, amount, description, 0, splitEqually(amount, await memberIds(groupId)));
    }],

    // Paying someone back is stored as an expense whose only share belongs to the person paid.
    ['POST', /^\/api\/groups\/(\d+)\/payments$/, async ({ req, body, params: [groupId] }) => {
      const user = await currentUser(req);
      await requireMember(groupId, user.id);
      if (body.to === user.id || !(await memberIds(groupId)).includes(body.to)) throw new HttpError(400, 'Choose another member of this group');
      const amount = parsePence(body.amount);
      await insertExpense(groupId, user.id, amount, 'Payment', 1, [{ userId: body.to, amount }]);
    }],

    ['DELETE', /^\/api\/expenses\/(\d+)$/, async ({ req, params: [expenseId] }) => {
      const user = await currentUser(req);
      const expense = await get('SELECT group_id, paid_by FROM expenses WHERE id = ?', expenseId);
      if (!expense) throw new HttpError(404, 'Expense not found');
      await requireMember(expense.group_id, user.id);
      if (expense.paid_by !== user.id) throw new HttpError(403, 'Only the person who paid can delete this');
      await db.batch([
        { sql: 'DELETE FROM shares WHERE expense_id = ?', args: [expenseId] },
        { sql: 'DELETE FROM expenses WHERE id = ?', args: [expenseId] },
      ], 'write');
    }],
  ];

  function send(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      const file = STATIC[pathname];
      if (req.method === 'GET' && file) {
        res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
        return res.end(fs.readFileSync(path.join(__dirname, 'public', file[0])));
      }
      for (const [method, pattern, handler] of routes) {
        const match = req.method === method && pattern.exec(pathname);
        if (!match) continue;
        const body = method === 'POST' ? await readJson(req) : {};
        return send(res, 200, await handler({ req, res, body, params: match.slice(1).map(Number) }) ?? {});
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      send(res, e instanceof HttpError ? e.status : 500, { error: e instanceof HttpError ? e.message : 'Something went wrong' });
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const dbConfig = process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: `file:${path.join(__dirname, 'data.db')}` };
  if (PRODUCTION && !process.env.TURSO_DATABASE_URL) {
    // a host's local disk is wiped on every restart, which would silently delete every account
    console.error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before running in production.');
    process.exit(1);
  }
  createApp(dbConfig).then((server) => server.listen(port, () => console.log(`Expense splitter running at http://localhost:${port}`)));
}

module.exports = { createApp };
