export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendOk(res, data, extra = {}) {
  sendJson(res, 200, { ok: true, data, ...extra });
}

export function sendCreated(res, data) {
  sendJson(res, 201, { ok: true, data });
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

export class BadJsonError extends Error {}

export async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadJsonError('request body is not valid JSON');
  }
}
