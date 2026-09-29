/**
 * Canonical form of an email address for duplicate detection: surrounding
 * whitespace removed, lower-cased, and any `+tag` dropped from the local part
 * (`Ann.Lee+news@Example.com` -> `ann.lee@example.com`).
 */
export function normalizeEmail(email) {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at === -1) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const plus = local.indexOf('+');
  return (plus === -1 ? local : local.slice(0, plus)) + '@' + domain;
}

/**
 * Finds users that share an email address once normalized.
 *
 * Returns one group per shared address, each group a list of row indices in
 * ascending order. Only addresses used by two or more rows are reported, and
 * the groups are ordered by their first index.
 */
export function findDuplicateEmails(rows) {
  const byEmail = new Map();
  for (let i = 0; i < rows.length; i++) {
    const key = normalizeEmail(rows[i].email);
    const group = byEmail.get(key);
    if (group) group.push(i);
    else byEmail.set(key, [i]);
  }
  return [...byEmail.values()].filter((group) => group.length > 1);
}
