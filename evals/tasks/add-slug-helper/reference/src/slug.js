/**
 * Turn a human title into a URL slug:
 *   "Node.js: The Good Parts!" -> "nodejs-the-good-parts"
 * Lowercase, strip anything that isn't a letter/digit/space, collapse runs of
 * whitespace to a single hyphen, and trim leading/trailing hyphens.
 */
export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}
