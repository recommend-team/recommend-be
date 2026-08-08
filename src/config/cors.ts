/**
 * The single source of truth for which origins may reach this API.
 *
 * There are two CORS surfaces — Express (`enableCors`) and Socket.IO, which does its own
 * and ignores Express entirely. When they were maintained separately it was possible to
 * allow an origin for REST and silently refuse its websocket, which presents as a broken
 * chat rather than a configuration problem. Both now call this.
 *
 * Read from `process.env` rather than ConfigService because the gateway's `@WebSocketGateway`
 * decorator is evaluated before any DI container exists.
 */

/** Local dev servers we always allow: Next (3000), Vite (5173), Vite preview (4173). */
const LOCAL_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:4173',
];

export function allowedOrigins(): string[] {
  // FRONTEND_URLS (plural) is comma-separated. There is more than one frontend now —
  // the vendor/admin web app and the customer PWA are separate origins.
  const configured = (
    process.env.FRONTEND_URLS ??
    process.env.FRONTEND_URL ??
    ''
  )
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (process.env.NODE_ENV === 'production') return configured;

  return [...new Set([...configured, ...LOCAL_ORIGINS])];
}
