import { findDuplicateEmails } from '../src/dedupe.js';

const FIRST = ['ann', 'ben', 'carla', 'dev', 'eun', 'farah', 'gus', 'hana', 'ivan', 'jo', 'kofi', 'lena', 'mo', 'nia', 'omar', 'priya'];
const LAST = ['lee', 'smith', 'okafor', 'garcia', 'kim', 'novak', 'silva', 'chen', 'haddad', 'ivanova', 'patel', 'moreau'];
const DOMAINS = ['example.com', 'mail.test', 'corp.example', 'inbox.test'];

// Small seeded PRNG so every run benches the same data.
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeUsers(count, seed = 42) {
  const rand = mulberry32(seed);
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const users = [];
  for (let i = 0; i < count; i++) {
    if (i > 0 && rand() < 0.04) {
      // A returning user signing up again with a variant of an earlier address.
      const [local, domain] = users[Math.floor(rand() * i)].email.trim().split('@');
      const variant = rand() < 0.5 ? `${local}+${pick(['news', 'shop', 'x'])}` : local.toUpperCase();
      users.push({ id: i + 1, name: `user ${i + 1}`, email: rand() < 0.3 ? ` ${variant}@${domain} ` : `${variant}@${domain}` });
      continue;
    }
    const first = pick(FIRST);
    const last = pick(LAST);
    const n = Math.floor(rand() * 100000);
    users.push({ id: i + 1, name: `${first} ${last}`, email: `${first}.${last}${n}@${pick(DOMAINS)}` });
  }
  return users;
}

const count = Number(process.argv[2] ?? 20000);
const users = makeUsers(count);
const start = performance.now();
const groups = findDuplicateEmails(users);
const ms = performance.now() - start;
console.log(`${count} users, ${groups.length} duplicate groups, ${ms.toFixed(0)} ms`);
