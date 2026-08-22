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

/**
 * Local dev servers. Not included in deployed environments.
 *
 * Ports are assigned per app so they can all run at once — which they have to, because
 * a vendor marking an order ready and a buyer seeing it are two apps and one database.
 */
const LOCAL_ORIGINS = [
  'http://localhost:3000', // recommend-fe (Next)
  'http://localhost:5173', // recommend_customer_app (Vite dev)
  'http://localhost:4173', // recommend_customer_app (Vite preview)
  'http://localhost:5174', // recommend_vendors (Vite dev)
  'http://localhost:4174', // recommend_vendors (Vite preview)
];

export function allowedOrigins(): string[] {
  // FRONTEND_URLS (plural) is comma-separated. There is more than one frontend now —
  // the vendor/admin web app and the customer PWA are separate origins.
  //
  // Deployed origins are configured per service rather than hardcoded here. Staging and
  // production point at different frontends but both run with NODE_ENV=production —
  // `config.validation.ts` admits only development/production/test, so there is no third
  // value to branch on. The Render service is the only thing that knows which it is.
  const configured = (
    process.env.FRONTEND_URLS ??
    process.env.FRONTEND_URL ??
    ''
  )
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (process.env.NODE_ENV === 'production') {
    if (configured.length === 0) {
      // An empty allowlist blocks every browser request. Better to refuse to boot than
      // to come up healthy with every frontend locked out.
      throw new Error(
        'FRONTEND_URLS must be set in production — an empty CORS allowlist blocks all frontends',
      );
    }
    return [...new Set(configured)];
  }

  return [...new Set([...configured, ...LOCAL_ORIGINS])];
}
