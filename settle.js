// The money maths, kept pure so it can be tested without a server or database.
// All amounts are whole pence: floats can't represent 0.1 exactly, integers never drift.
'use strict';

// Split an amount between people. Leftover pennies go to the first people in the list,
// so the shares always add up to exactly the amount.
function splitEqually(amount, userIds) {
  const base = Math.floor(amount / userIds.length);
  const extra = amount - base * userIds.length;
  return userIds.map((userId, i) => ({ userId, amount: base + (i < extra ? 1 : 0) }));
}

// Net position of each member: positive means the group owes them, negative means they owe.
function balances(memberIds, expenses) {
  const net = new Map(memberIds.map((id) => [id, 0]));
  for (const e of expenses) {
    net.set(e.paidBy, net.get(e.paidBy) + e.amount);
    for (const s of e.shares) net.set(s.userId, net.get(s.userId) - s.amount);
  }
  return net;
}

// Turn balances into "A pays B" transfers by repeatedly matching the biggest debtor with
// the biggest creditor. Each transfer clears at least one person, so n people need at most n-1.
function settle(net) {
  const people = [...net].map(([userId, amount]) => ({ userId, amount })).filter((p) => p.amount !== 0);
  const transfers = [];
  for (;;) {
    people.sort((a, b) => a.amount - b.amount);
    const debtor = people[0], creditor = people[people.length - 1];
    if (!debtor || debtor.amount >= 0) return transfers;
    const amount = Math.min(-debtor.amount, creditor.amount);
    transfers.push({ from: debtor.userId, to: creditor.userId, amount });
    debtor.amount += amount;
    creditor.amount -= amount;
  }
}

module.exports = { splitEqually, balances, settle };
