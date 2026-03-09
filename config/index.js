/**
 * Next.js config wrapper for thepopebot.
 * Enables instrumentation hook for cron scheduling on server start.
 *
 * Usage in user's next.config.mjs:
 *   import { withThepopebot } from 'thepopebot/config';
 *   export default withThepopebot({});
 *
 * @param {Object} nextConfig - User's Next.js config
 * @returns {Object} Enhanced Next.js config
 */
export function withThepopebot(nextConfig = {}) {
  return {
    ...nextConfig,
    distDir: process.env.NEXT_BUILD_DIR || '.next',
    // Only mark native-binding packages as server externals — they cannot be
    // webpack-bundled.  thepopebot itself must NOT be external: Next.js needs
    // to process it to respect 'use client' boundaries inside the package.
    // (esbuild pre-compiles JSX→JS in stage 1, so webpack only needs to parse
    // plain JS — no JSX transform required.)
    serverExternalPackages: [
      'better-sqlite3',
      'drizzle-orm',
      ...(nextConfig.serverExternalPackages || []),
    ],
    env: {
      ...nextConfig.env,
      NEXT_PUBLIC_CODE_WORKSPACE: process.env.CLAUDE_CODE_OAUTH_TOKEN && process.env.BETA ? 'true' : '',
    },
  };
}
