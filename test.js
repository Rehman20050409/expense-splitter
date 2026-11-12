// Run with: node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { splitEqually, balances, settle } = require('./settle.js');
const { createApp } = require('./server.js');

test('splitEqually hands leftover pennies to the first people', () => {
  assert.deepEqual(splitEqually(1000, [1, 2, 3]).map((s) => s.amount), [334, 333, 333]);
  assert.deepEqual(splitEqually(1, [1, 2]).map((s) => s.amount), [1, 0]);
});

test('balances always sum to zero', () => {
  const expenses = [
    { paidBy: 1, amount: 1000, shares: splitEqually(1000, [1, 2, 3]) },
    { paidBy: 2, amount: 599, shares: splitEqually(599, [1, 2, 3]) },
  ];
  const net = balances([1, 2, 3], expenses);
  assert.deepEqual([...net], [[1, 466], [2, 66], [3, -532]]);
  assert.equal([...net.values()].reduce((a, b) => a + b), 0);
});

test('settle clears every balance in at most n-1 transfers', () => {
  const net = new Map([[1, 700], [2, -100], [3, -400], [4, -200]]);
  const transfers = settle(net);
  assert.ok(transfers.length <= 3);
  for (const t of transfers) {
    net.set(t.from, net.get(t.from) + t.amount);
    net.set(t.to, net.get(t.to) - t.amount);
  }
  assert.deepEqual([...net.values()], [0, 0, 0, 0]);
  assert.deepEqual(settle(new Map([[1, 0], [2, 0]])), []);
});

test('API: accounts, groups, expenses and paying back', async (t) => {
  const server = await createApp({ url: ':memory:' });
  await new Promise((resolve) => server.listen(0, resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;

  // each client keeps its own session cookie, like a separate browser
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  };
  const alice = client(), bob = client(), carol = client(), nobody = client();
  const signUp = (c, name) => c('POST', '/api/register', { name, email: `${name}@example.com`, password: 'correct horse' });

  assert.equal((await nobody('GET', '/api/me')).status, 401);
  assert.equal((await signUp(alice, 'alice')).status, 200);
  assert.equal((await signUp(bob, 'bob')).status, 200);
  assert.equal((await signUp(carol, 'carol')).status, 200);
  assert.equal((await signUp(nobody, 'alice')).status, 409);
  assert.equal((await nobody('POST', '/api/register', { name: 'x', email: 'x@example.com', password: 'short' })).status, 400);
  assert.equal((await nobody('POST', '/api/login', { email: 'alice@example.com', password: 'wrong password' })).status, 401);

  const groupId = (await alice('POST', '/api/groups', { name: 'Flat 3' })).data.id;
  const { group } = (await alice('GET', `/api/groups/${groupId}`)).data;
  assert.equal((await bob('POST', '/api/groups/join', { code: group.code })).data.id, groupId);
  assert.equal((await carol('GET', `/api/groups/${groupId}`)).status, 404);
  assert.equal((await carol('POST', `/api/groups/${groupId}/expenses`, { description: 'Sneaky', amount: '5' })).status, 404);

  assert.equal((await alice('POST', `/api/groups/${groupId}/expenses`, { description: 'Shopping', amount: 'lots' })).status, 400);
  assert.equal((await alice('POST', `/api/groups/${groupId}/expenses`, { description: 'Shopping', amount: '10.01' })).status, 200);

  let state = (await bob('GET', `/api/groups/${groupId}`)).data;
  const [aliceId, bobId] = state.members.map((m) => m.id);
  assert.deepEqual(state.balances, [{ userId: aliceId, amount: 500 }, { userId: bobId, amount: -500 }]);
  assert.deepEqual(state.transfers, [{ from: bobId, to: aliceId, amount: 500 }]);

  assert.equal((await bob('DELETE', `/api/expenses/${state.expenses[0].id}`)).status, 403);
  assert.equal((await bob('POST', `/api/groups/${groupId}/payments`, { to: bobId, amount: '5.00' })).status, 400);
  assert.equal((await bob('POST', `/api/groups/${groupId}/payments`, { to: aliceId, amount: '5.00' })).status, 200);
  state = (await bob('GET', `/api/groups/${groupId}`)).data;
  assert.deepEqual(state.transfers, []);

  // logging out kills the session, logging back in restores access
  await bob('POST', '/api/logout', {});
  assert.equal((await bob('GET', '/api/me')).status, 401);
  assert.equal((await bob('POST', '/api/login', { email: 'BOB@example.com', password: 'correct horse' })).status, 200);
  assert.equal((await bob('GET', '/api/me')).data.groups.length, 1);

  // deleting your own expense removes it and its shares, so balances go back
  await alice('DELETE', `/api/expenses/${state.expenses.at(-1).id}`);
  state = (await alice('GET', `/api/groups/${groupId}`)).data;
  assert.equal(state.expenses.length, 1);
  assert.deepEqual(state.balances, [{ userId: aliceId, amount: -500 }, { userId: bobId, amount: 500 }]);

  // password guessing is cut off: 10 wrong tries, then even the right password has to wait
  const guess = (password) => nobody('POST', '/api/login', { email: 'carol@example.com', password });
  for (let i = 0; i < 10; i++) assert.equal((await guess('wrong password')).status, 401);
  assert.equal((await guess('correct horse')).status, 429);
});
