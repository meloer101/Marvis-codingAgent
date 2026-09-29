export class Router {
  #routes = [];

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  add(method, pattern, handler) {
    const keys = [];
    const source = pattern.replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
    this.#routes.push({ method, regex: new RegExp(`^${source}`), keys, handler });
    return this;
  }

  lookup(method, rawUrl) {
    const url = new URL(rawUrl, 'http://localhost');
    for (const route of this.#routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const params = {};
      route.keys.forEach((key, i) => {
        params[key] = decodeURIComponent(match[i + 1]);
      });
      return { handler: route.handler, params, query: Object.fromEntries(url.searchParams) };
    }
    return null;
  }
}
