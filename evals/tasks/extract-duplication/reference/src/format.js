function normalizeName(raw) {
  const name = raw.trim().replace(/\s+/g, ' ');
  const initials = name
    .split(' ')
    .map((part) => part[0].toUpperCase())
    .join('');
  return { name, initials };
}

export function formatUser(user) {
  const { name, initials } = normalizeName(user.name);
  return `${name} (${initials})`;
}

export function formatTeam(team) {
  const { name, initials } = normalizeName(team.name);
  return `Team ${name} [${initials}]`;
}
