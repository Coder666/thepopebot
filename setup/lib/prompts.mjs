import * as clack from '@clack/prompts';
import open from 'open';
import { PROVIDERS } from './providers.mjs';

/**
 * Mask a secret, showing only last 4 characters
 */
export function maskSecret(secret) {
  if (!secret || secret.length < 8) return '****';
  return '****' + secret.slice(-4);
}

/**
 * Handle cancel — exits cleanly if user pressed Ctrl+C
 */
function handleCancel(value) {
  if (clack.isCancel(value)) {
    clack.cancel('Setup cancelled.');
    process.exit(0);
  }
  return value;
}

/**
 * Boolean gate — returns true (keep existing) or false (must configure).
 * If no displayValue, returns false (must configure).
 */
export async function keepOrReconfigure(label, displayValue) {
  if (!displayValue) return false;
  clack.log.success(`${label}: ${displayValue}`);
  const reconfig = handleCancel(await clack.confirm({
    message: 'Reconfigure?',
    initialValue: false,
  }));
  return !reconfig;
}

/**
 * Prompt for GitHub PAT
 */
export async function promptForPAT() {
  const pat = handleCancel(await clack.password({
    message: 'Paste your GitHub Personal Access Token:',
    validate: (input) => {
      if (!input) return 'PAT is required';
      if (!input.startsWith('ghp_') && !input.startsWith('github_pat_')) {
        return 'Invalid PAT format. Should start with ghp_ or github_pat_';
      }
    },
  }));
  return pat;
}

/**
 * Prompt for LLM provider selection
 */
export async function promptForProvider() {
  const options = Object.entries(PROVIDERS).map(([key, p]) => ({
    label: p.label,
    value: key,
  }));
  options.push({ label: 'Local (OpenAI Compatible API)', value: 'custom' });

  const provider = handleCancel(await clack.select({
    message: 'Which LLM for your agent?',
    options,
  }));
  return provider;
}

/**
 * Prompt for model selection from a provider's model list
 * @param {string} providerKey - Provider key from PROVIDERS registry
 * @param {object} [options] - Options
 * @param {string} [options.defaultModelId] - Override which model gets "(recommended)" instead of the registry default
 */
export async function promptForModel(providerKey, { defaultModelId } = {}) {
  const provider = PROVIDERS[providerKey];
  const isRecommended = (m) => defaultModelId ? m.id === defaultModelId : m.default;
  const sorted = [...provider.models].sort((a, b) => isRecommended(b) - isRecommended(a));
  const options = sorted.map((m) => ({
    label: isRecommended(m) ? `${m.name} (recommended)` : m.name,
    value: m.id,
  }));
  options.push({ label: 'Custom (enter model ID)', value: '__custom__' });

  const model = handleCancel(await clack.select({
    message: 'Which model?',
    options,
  }));

  if (model === '__custom__') {
    const customModel = handleCancel(await clack.text({
      message: `Enter ${provider.name} model ID:`,
      validate: (input) => {
        if (!input) return 'Model ID is required';
      },
    }));
    return customModel;
  }

  return model;
}

/**
 * Prompt for an API key for a known provider
 */
export async function promptForApiKey(providerKey) {
  const provider = PROVIDERS[providerKey];

  const openPage = handleCancel(await clack.confirm({
    message: `Open ${provider.name} API key page in browser?`,
    initialValue: true,
  }));
  if (openPage) {
    await open(provider.keyPage);
  }

  const key = handleCancel(await clack.password({
    message: `Enter your ${provider.name} API key:`,
    validate: (input) => {
      if (!input) return `${provider.name} API key is required`;
      if (provider.keyPrefix && !input.startsWith(provider.keyPrefix)) {
        return `Invalid format. Should start with ${provider.keyPrefix}`;
      }
    },
  }));
  return key;
}

/**
 * Prompt for an optional API key with a purpose description
 */
export async function promptForOptionalKey(providerKey, purpose) {
  const provider = PROVIDERS[providerKey];

  const addKey = handleCancel(await clack.confirm({
    message: `Add ${provider.name} API key for ${purpose}? (optional)`,
    initialValue: false,
  }));

  if (!addKey) return null;

  const openPage = handleCancel(await clack.confirm({
    message: `Open ${provider.name} API key page in browser?`,
    initialValue: true,
  }));
  if (openPage) {
    await open(provider.keyPage);
  }

  const key = handleCancel(await clack.password({
    message: `Enter your ${provider.name} API key:`,
    validate: (input) => {
      if (!input) return 'Key is required if adding';
      if (provider.keyPrefix && !input.startsWith(provider.keyPrefix)) {
        return `Invalid format. Should start with ${provider.keyPrefix}`;
      }
    },
  }));
  return key;
}

/**
 * Prompt for custom/local LLM provider details
 */
export async function promptForCustomProvider() {
  const baseUrl = handleCancel(await clack.text({
    message: 'API base URL (e.g., http://host.docker.internal:11434/v1):',
    validate: (input) => {
      if (!input) return 'Base URL is required';
      if (!input.startsWith('http://') && !input.startsWith('https://')) {
        return 'URL must start with http:// or https://';
      }
    },
  }));

  const model = handleCancel(await clack.text({
    message: 'Model ID (e.g., qwen3:8b):',
    validate: (input) => {
      if (!input) return 'Model ID is required';
    },
  }));

  const apiKey = handleCancel(await clack.password({
    message: 'API key (leave blank if not needed):',
  }));

  const contextWindowChoice = handleCancel(await clack.select({
    message: 'Context window size (tokens)?',
    options: [
      { label: '8 192  — Llama 3.2, Mistral 7B, Gemma 2 (default)', value: '8192' },
      { label: '4 096  — Phi-3 mini and other small models', value: '4096' },
      { label: '16 384 — Mid-range models', value: '16384' },
      { label: '32 768 — Qwen 2.5 and larger models', value: '32768' },
      { label: '131 072 — Llama 3.1/3.3 70B+ with full context', value: '131072' },
      { label: 'Custom — enter manually', value: '__custom__' },
    ],
  }));

  let contextWindow = contextWindowChoice;
  if (contextWindowChoice === '__custom__') {
    contextWindow = handleCancel(await clack.text({
      message: 'Context window in tokens:',
      validate: (input) => {
        if (!input) return 'Required';
        if (isNaN(Number(input)) || Number(input) < 512) return 'Must be a number >= 512';
      },
    }));
  }

  return { baseUrl, model, apiKey: apiKey || '', contextWindow };
}

/**
 * Prompt for optional Brave Search API key
 */
export async function promptForBraveKey() {
  const addKey = handleCancel(await clack.confirm({
    message: 'Add Brave Search API key? (optional, lets your agent search the web)',
    initialValue: false,
  }));

  if (!addKey) return null;

  clack.log.info(
    'To get a Brave Search API key:\n' +
    '  1. Go to https://api-dashboard.search.brave.com/app/keys\n' +
    '  2. Click "Get Started"\n' +
    '  3. Create an account (or sign in)\n' +
    '  4. Subscribe to a plan (free credits may be available)\n' +
    '  5. Copy your API key'
  );

  const openPage = handleCancel(await clack.confirm({
    message: 'Open Brave Search API page in browser?',
    initialValue: true,
  }));
  if (openPage) {
    await open('https://api-dashboard.search.brave.com/app/keys');
  }

  const key = handleCancel(await clack.password({
    message: 'Enter your Brave Search API key:',
    validate: (input) => {
      if (!input) return 'Key is required if adding';
    },
  }));
  return key;
}

/**
 * Generate a Telegram webhook secret
 */
export async function generateTelegramWebhookSecret() {
  const { randomBytes } = await import('crypto');
  return randomBytes(32).toString('hex');
}

/**
 * Prompt for confirmation (wraps clack.confirm with cancel handling)
 */
export async function confirm(message, initialValue = true) {
  const result = handleCancel(await clack.confirm({
    message,
    initialValue,
  }));
  return result;
}

/**
 * Press enter to continue
 */
export async function pressEnter(message = 'Press enter to continue') {
  handleCancel(await clack.text({
    message,
    defaultValue: '',
  }));
}

/**
 * Prompt for text input
 */
export async function promptText(message, defaultValue = '') {
  const value = handleCancel(await clack.text({
    message,
    defaultValue,
  }));
  return value;
}
