# Split — shared expenses for flatmates

A full-stack web app for splitting costs. Create a group, invite your flatmates with a code, add what you paid for, and it works out who owes who in the fewest payments.

Built with Node.js and SQLite using **only the standard library**: no frameworks and no `npm install`.

## Run it

Needs Node 22.13 or newer.

```
npm start
```

Then open http://localhost:3000. Data is saved in `data.db` next to the server.

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
- The session cookie is `HttpOnly` and `SameSite=Strict`. The database stores only a hash of the session token.
- Every group route checks that you are a member. Non-members get a 404, so group ids can't be probed.
- All SQL uses bound parameters, and the front end only ever inserts user text as text, never as HTML.

Known limits, marked with `shortcut:` comments in the code: no login rate limiting, and the cookie has no `Secure` flag because it runs on plain `http://localhost`. Both need fixing before putting it on the public internet.

## Tests

```
npm test
```
