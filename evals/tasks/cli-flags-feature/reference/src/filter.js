const SEVERITY = { debug: 10, info: 20, warn: 30, error: 40 };

export function buildFilter({ level, svc, since }) {
  const tests = [];
  if (level) tests.push((event) => (SEVERITY[event.level] ?? 0) >= SEVERITY[level]);
  if (svc) tests.push((event) => event.svc === svc);
  if (since) tests.push((event) => Date.parse(event.ts) >= since.getTime());
  return (event) => tests.every((test) => test(event));
}
