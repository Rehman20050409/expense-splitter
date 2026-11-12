// Expense splitter: HTTP API + static files, using only Node's standard library.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { splitEqually, balances, settle } = require('./settle.js');

const SESSION_SECONDS = 30 * 24 * 60 * 60;
// Fixed list of files, so a request path can never reach outside public/.
const STATIC = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys = ON;
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
      expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL,
      PRIMARY KEY (expense_id, user_id));
  `);
  return db;
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

function createApp(dbFile) {
  const db = openDb(dbFile);
  const sql = (query) => db.prepare(query);

  // The cookie holds a random token; the database only stores its hash, so a leaked
  // database can't be used to log in as anyone.
  // shortcut: no Secure flag so it works on http://localhost, add it when served over HTTPS
  function setCookie(res, token, maxAge) {
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
  }
  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    sql('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha256(token), userId, now() + SESSION_SECONDS);
    setCookie(res, token, SESSION_SECONDS);
  }
  const sessionToken = (req) => /(?:^|;\s*)sid=([0-9a-f]{64})/.exec(req.headers.cookie || '')?.[1];

  function currentUser(req) {
    const token = sessionToken(req);
    const user = token && sql(
      'SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?'
    ).get(sha256(token), now());
    if (!user) throw new HttpError(401, 'Please log in');
    return user;
  }

  // 404 rather than 403, so non-members can't tell which group ids exist.
  function requireMember(groupId, userId) {
    if (!sql('SELECT 1 FROM members WHERE group_id = ? AND user_id = ?').get(groupId, userId)) {
      throw new HttpError(404, 'Group not found');
    }
  }
  const memberIds = (groupId) => sql('SELECT user_id FROM members WHERE group_id = ? ORDER BY user_id').all(groupId).map((r) => r.user_id);

  function insertExpense(groupId, paidBy, amount, description, isPayment, shares) {
    db.exec('BEGIN');
    try {
      const { lastInsertRowid } = sql(
        'INSERT INTO expenses (group_id, paid_by, amount, description, is_payment, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(groupId, paidBy, amount, description, isPayment, now());
      for (const s of shares) sql('INSERT INTO shares (expense_id, user_id, amount) VALUES (?, ?, ?)').run(lastInsertRowid, s.userId, s.amount);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  const routes = [
    ['POST', /^\/api\/register$/, ({ res, body }) => {
      const name = text(body, 'name', 60);
      const email = text(body, 'email', 200).toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
      if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 200) {
        throw new HttpError(400, 'Password must be at least 8 characters');
      }
      if (sql('SELECT 1 FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'That email is already registered');
      const { lastInsertRowid } = sql('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name, email, hashPassword(body.password));
      startSession(res, Number(lastInsertRowid));
    }],

    // shortcut: no rate limiting on login, add it before putting this on the public internet
    ['POST', /^\/api\/login$/, ({ res, body }) => {
      const user = sql('SELECT id, password FROM users WHERE email = ?').get(String(body.email || '').trim().toLowerCase());
      if (!user || typeof body.password !== 'string' || !passwordMatches(body.password, user.password)) {
        throw new HttpError(401, 'Wrong email or password');
      }
      startSession(res, user.id);
    }],

    ['POST', /^\/api\/logout$/, ({ req, res }) => {
      const token = sessionToken(req);
      if (token) sql('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
      setCookie(res, '', 0);
    }],

    ['GET', /^\/api\/me$/, ({ req }) => {
      const user = currentUser(req);
      const groups = sql('SELECT g.id, g.name FROM grp g JOIN members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.id').all(user.id);
      return { user, groups };
    }],

    ['POST', /^\/api\/groups$/, ({ req, body }) => {
      const user = currentUser(req);
      const name = text(body, 'name', 60);
      const code = crypto.randomBytes(6).toString('base64url');
      const id = Number(sql('INSERT INTO grp (name, code) VALUES (?, ?)').run(name, code).lastInsertRowid);
      sql('INSERT INTO members (group_id, user_id) VALUES (?, ?)').run(id, user.id);
      return { id };
    }],

    ['POST', /^\/api\/groups\/join$/, ({ req, body }) => {
      const user = currentUser(req);
      const group = sql('SELECT id FROM grp WHERE code = ?').get(String(body.code || '').trim());
      if (!group) throw new HttpError(404, 'No group has that invite code');
      sql('INSERT OR IGNORE INTO members (group_id, user_id) VALUES (?, ?)').run(group.id, user.id);
      return { id: group.id };
    }],

    ['GET', /^\/api\/groups\/(\d+)$/, ({ req, params: [groupId] }) => {
      const user = currentUser(req);
      requireMember(groupId, user.id);
      const members = sql('SELECT u.id, u.name FROM users u JOIN members m ON m.user_id = u.id WHERE m.group_id = ? ORDER BY u.id').all(groupId);
      const shares = sql('SELECT s.expense_id, s.user_id, s.amount FROM shares s JOIN expenses e ON e.id = s.expense_id WHERE e.group_id = ?').all(groupId);
      const expenses = sql('SELECT id, paid_by, amount, description, is_payment, created_at FROM expenses WHERE group_id = ? ORDER BY id DESC').all(groupId)
        .map((e) => ({
          id: e.id, paidBy: e.paid_by, amount: e.amount, description: e.description, isPayment: !!e.is_payment, createdAt: e.created_at,
          shares: shares.filter((s) => s.expense_id === e.id).map((s) => ({ userId: s.user_id, amount: s.amount })),
        }));
      const net = balances(members.map((m) => m.id), expenses);
      return {
        group: sql('SELECT id, name, code FROM grp WHERE id = ?').get(groupId),
        members, expenses,
        balances: [...net].map(([userId, amount]) => ({ userId, amount })),
        transfers: settle(net),
      };
    }],

    ['POST', /^\/api\/groups\/(\d+)\/expenses$/, ({ req, body, params: [groupId] }) => {
      const user = currentUser(req);
      requireMember(groupId, user.id);
      const description = text(body, 'description', 100);
      const amount = parsePence(body.amount);
      insertExpense(groupId, user.id, amount, description, 0, splitEqually(amount, memberIds(groupId)));
    }],

    // Paying someone back is stored as an expense whose only share belongs to the person paid.
    ['POST', /^\/api\/groups\/(\d+)\/payments$/, ({ req, body, params: [groupId] }) => {
      const user = currentUser(req);
      requireMember(groupId, user.id);
      if (body.to === user.id || !memberIds(groupId).includes(body.to)) throw new HttpError(400, 'Choose another member of this group');
      const amount = parsePence(body.amount);
      insertExpense(groupId, user.id, amount, 'Payment', 1, [{ userId: body.to, amount }]);
    }],

    ['DELETE', /^\/api\/expenses\/(\d+)$/, ({ req, params: [expenseId] }) => {
      const user = currentUser(req);
      const expense = sql('SELECT group_id, paid_by FROM expenses WHERE id = ?').get(expenseId);
      if (!expense) throw new HttpError(404, 'Expense not found');
      requireMember(expense.group_id, user.id);
      if (expense.paid_by !== user.id) throw new HttpError(403, 'Only the person who paid can delete this');
      sql('DELETE FROM expenses WHERE id = ?').run(expenseId);
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
        return send(res, 200, handler({ req, res, body, params: match.slice(1).map(Number) }) ?? {});
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
  createApp(path.join(__dirname, 'data.db')).listen(port, () => console.log(`Expense splitter running at http://localhost:${port}`));
}

module.exports = { createApp };
