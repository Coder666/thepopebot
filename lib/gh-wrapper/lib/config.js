'use strict';

/**
 * gh-wrapper configuration.
 *
 * Environment variables:
 *   GH_WRAPPER_BACKEND  - 'github' (default, passthrough) or 'gitea'
 *   GITEA_URL           - Base URL of your Gitea instance (required for gitea backend)
 *   GITEA_TOKEN         - Gitea API token (falls back to GH_TOKEN)
 *
 * Example:
 *   GH_WRAPPER_BACKEND=gitea GITEA_URL=https://gitea.example.com GITEA_TOKEN=my_token gh secret set FOO
 */

const config = {
  backend: process.env.GH_WRAPPER_BACKEND || 'github',
  giteaUrl: (process.env.GITEA_URL || '').replace(/\/$/, ''),
  // GITEA_TOKEN takes priority; fall back to GH_TOKEN which is standard in workflow contexts
  token: process.env.GITEA_TOKEN || process.env.GH_TOKEN || '',
};

/**
 * Get the correct API token for the current backend.
 * When GH_WRAPPER_BACKEND=gitea, returns GITEA_TOKEN (or GH_TOKEN fallback).
 * Otherwise returns GH_TOKEN.
 *
 * @returns {string} API token
 */
function getGhToken() {
  if ((process.env.GH_WRAPPER_BACKEND || 'github').toLowerCase() === 'gitea') {
    return process.env.GITEA_TOKEN || process.env.GH_TOKEN || '';
  }
  return process.env.GH_TOKEN || '';
}

/**
 * Get the correct API base URL for the current backend.
 * When GH_WRAPPER_BACKEND=gitea, returns `${GITEA_URL}/api/v1`.
 * Otherwise returns `https://api.github.com`.
 *
 * @returns {string} API base URL (no trailing slash)
 */
function getApiBaseUrl() {
  if ((process.env.GH_WRAPPER_BACKEND || 'github').toLowerCase() === 'gitea') {
    return `${config.giteaUrl}/api/v1`;
  }
  return 'https://api.github.com';
}

module.exports = config;
module.exports.getGhToken = getGhToken;
module.exports.getApiBaseUrl = getApiBaseUrl;

