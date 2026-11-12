// Front end: no framework. Each view is a function that returns DOM nodes.
'use strict';
const app = document.getElementById('app');
const errorBox = document.getElementById('error');
let me = null;
let registering = false;

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}

// h('li', { class: 'x', onclick: fn }, 'text', childNode). Text always goes in as text nodes,
// never HTML, so names and descriptions typed by other users can't inject markup.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  el.append(...children.filter((c) => c != null));
  return el;
}

const money = (pence) => `£${(pence / 100).toFixed(2)}`;
const field = (label, attrs) => h('label', {}, label, h('input', { required: '', ...attrs }));

// Wraps a form: send its fields to the API, then redraw. Errors show in the alert line.
function form(attrs, onSubmit, ...children) {
  return h('form', {
    ...attrs,
    onsubmit: async (event) => {
      event.preventDefault();
      await act(() => onSubmit(Object.fromEntries(new FormData(event.target))));
    },
  }, ...children);
}

async function act(fn) {
  errorBox.textContent = '';
  try {
    await fn();
    await render();
  } catch (e) {
    errorBox.textContent = e.message;
  }
}

function authView() {
  return [
    h('h1', {}, h('img', { src: '/logo.svg', alt: '', width: 36, height: 36 }), 'Split'),
    h('p', {}, 'Share costs with your flatmates and see who owes who.'),
    form({}, (data) => api('POST', registering ? '/api/register' : '/api/login', data),
      registering ? field('Name', { name: 'name', autocomplete: 'name', maxlength: 60 }) : null,
      field('Email', { name: 'email', type: 'email', autocomplete: 'email' }),
      field('Password', { name: 'password', type: 'password', minlength: 8, autocomplete: registering ? 'new-password' : 'current-password' }),
      h('button', {}, registering ? 'Create account' : 'Log in')),
    h('button', { class: 'quiet', type: 'button', onclick: () => { registering = !registering; render(); } },
      registering ? 'I already have an account' : 'Create an account'),
  ];
}

function topBar(title) {
  return h('div', { class: 'top' },
    h('h1', {}, title),
    h('button', { class: 'quiet', type: 'button', onclick: () => act(() => api('POST', '/api/logout', {})) }, `Log out ${me.user.name}`));
}

function homeView() {
  return [
    topBar('Your groups'),
    me.groups.length
      ? h('ul', {}, ...me.groups.map((g) => h('li', {}, h('a', { href: `#/g/${g.id}` }, g.name))))
      : h('p', {}, 'No groups yet. Create one, or join with an invite code.'),
    h('h2', {}, 'New group'),
    form({ class: 'row' }, async (data) => { location.hash = `#/g/${(await api('POST', '/api/groups', data)).id}`; },
      field('Group name', { name: 'name', maxlength: 60, placeholder: 'Flat 3' }), h('button', {}, 'Create')),
    h('h2', {}, 'Join a group'),
    form({ class: 'row' }, async (data) => { location.hash = `#/g/${(await api('POST', '/api/groups/join', data)).id}`; },
      field('Invite code', { name: 'code' }), h('button', {}, 'Join')),
  ];
}

async function groupView(groupId) {
  const { group, members, expenses, balances, transfers } = await api('GET', `/api/groups/${groupId}`);
  const name = (id) => (id === me.user.id ? 'You' : members.find((m) => m.id === id).name);
  const base = `/api/groups/${groupId}`;

  return [
    topBar(group.name),
    h('p', {}, h('a', { href: '#/' }, '← All groups'), ' · Invite code: ', h('code', {}, group.code)),

    h('h2', {}, 'Balances'),
    h('ul', {}, ...balances.map((b) => h('li', {},
      h('span', { class: 'text' }, name(b.userId)),
      b.amount === 0 ? h('span', {}, 'settled up')
        : h('span', { class: b.amount > 0 ? 'good' : 'bad' }, `${b.amount > 0 ? 'is owed' : 'owes'} ${money(Math.abs(b.amount))}`)))),

    h('h2', {}, 'Settle up'),
    transfers.length
      ? h('ul', {}, ...transfers.map((t) => h('li', {},
        h('span', { class: 'text' }, `${name(t.from)} → ${name(t.to)}: ${money(t.amount)}`),
        t.from === me.user.id
          ? h('button', { type: 'button', onclick: () => act(() => api('POST', `${base}/payments`, { to: t.to, amount: (t.amount / 100).toFixed(2) })) }, 'Mark as paid')
          : null)))
      : h('p', {}, 'Everyone is settled up.'),

    h('h2', {}, 'Add an expense'),
    form({ class: 'row3' }, (data) => api('POST', `${base}/expenses`, data),
      field('What was it?', { name: 'description', maxlength: 100, placeholder: 'Food shop' }),
      field('Amount (£)', { name: 'amount', inputmode: 'decimal', pattern: '\\d{1,7}(\\.\\d{1,2})?', placeholder: '12.50' }),
      h('button', {}, 'Add')),
    h('p', {}, `You paid; it is split equally between all ${members.length} members.`),

    h('h2', {}, 'History'),
    expenses.length
      ? h('ul', {}, ...expenses.map((e) => h('li', {},
        h('span', {},
          h('span', { class: 'text' }, e.isPayment ? `${name(e.paidBy)} paid ${name(e.shares[0].userId)} back` : e.description),
          h('small', {}, `${e.isPayment ? '' : `Paid by ${name(e.paidBy)} · `}${new Date(e.createdAt * 1000).toLocaleDateString()}`)),
        h('span', {},
          h('span', { class: 'text' }, money(e.amount)), ' ',
          e.paidBy === me.user.id
            ? h('button', { class: 'quiet', type: 'button', 'aria-label': `Delete ${e.description}`, onclick: () => act(() => api('DELETE', `/api/expenses/${e.id}`)) }, 'Delete')
            : null))))
      : h('p', {}, 'Nothing yet.'),
  ];
}

async function render() {
  let view;
  try {
    me = await api('GET', '/api/me');
    const groupId = /^#\/g\/(\d+)$/.exec(location.hash)?.[1];
    view = groupId ? await groupView(groupId) : homeView();
  } catch (e) {
    if (e.status === 401) view = authView();
    else {
      errorBox.textContent = e.message;
      location.hash = '#/';
      return;
    }
  }
  app.replaceChildren(...view.filter(Boolean));
}

window.addEventListener('hashchange', () => { errorBox.textContent = ''; render(); });
render();
