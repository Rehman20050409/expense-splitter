# Split — shared expenses for flatmates

A full-stack web app for splitting costs. Create a group, invite your flatmates with a code, add what you paid for, and it works out who owes who in the fewest payments.

Built with Node.js and SQLite and **no web framework**: the server is Node's standard library, and the only dependency is the database client.

## Run it

Needs Node 20 or newer.

```
npm install
npm start
```

Then open http://localhost:3000. Data is saved in `data.db` next to the server.

## Deploy it

A free host's disk is wiped on every restart, so in production the same code talks to a hosted SQLite database ([Turso](https://turso.tech)) and nothing else changes.

1. Create a Turso database and copy its URL (`libsql://…`) and an auth token.
2. Create a Node web service on a host such as [Render](https://render.com) from this repo, with build command `npm install` and start command `npm start`.
3. Set three environment variables on the host:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `TURSO_DATABASE_URL` | the `libsql://…` URL |
| `TURSO_AUTH_TOKEN` | the token |

The tables are created on first start. With `NODE_ENV=production` the server refuses to start without a database URL, so it can never quietly fall back to a disk that gets wiped.

## Features

- Accounts with email and password, and log in / log out
- Groups you join with an invite code
- Add an expense and it is split equally between everyone in the group
- Live balances, plus a "settle up" list of who should pay who
- Mark a payment as paid, delete your own expenses

## How it works

| File | What it does |
| --- | --- |
| [`settle.js`](settle.js) | The money maths: splitting, balances and the settle-up algorithm. Pure functions, no I/O. |
| [`server.js`](server.js) | JSON API, sessions and SQLite storage. |
| [`public/`](public) | The front end in plain HTML, CSS and JavaScript. |
| [`test.js`](test.js) | Unit tests for the maths and an end-to-end test of the API. |

**Money is stored as whole pence.** Floating point can't represent 0.1 exactly, so `0.1 + 0.2` isn't `0.3`. Amounts are parsed from text straight into integers, and when a bill doesn't divide evenly the leftover pennies go to the first people, so shares always add up to the exact total.

**Settling up** matches the person who owes the most with the person owed the most, over and over. Every payment clears at least one person, so a group of *n* people never needs more than *n − 1* payments.

**Security**

- Passwords are hashed with scrypt and a per-user salt, and compared in constant time.
- The session cookie is `HttpOnly` and `SameSite=Strict`, and `Secure` in production. The database stores only a hash of the session token.
- Logins are rate limited: ten wrong tries for an email from one address, then a 15 minute wait.
- Every group route checks that you are a member. Non-members get a 404, so group ids can't be probed.
- All SQL uses bound parameters, and the front end only ever inserts user text as text, never as HTML.

Known limits, marked with `shortcut:` comments in the code: the login counter lives in memory, so it resets on restart, and password hashing briefly blocks the server. Both are fine for one small server and would need changing at scale.

## Tests

```
npm test
```
