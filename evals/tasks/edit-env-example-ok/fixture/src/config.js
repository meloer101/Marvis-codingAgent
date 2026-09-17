export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    apiSecret: env.API_SECRET,
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
