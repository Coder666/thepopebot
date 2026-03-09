#!/usr/bin/env node

import chalk from 'chalk';
import open from 'open';
import * as clack from '@clack/prompts';

import { checkPrerequisites } from './lib/prerequisites.mjs';
import { setVariables, setSecrets } from './lib/github.mjs';
import { setTelegramWebhook, validateBotToken, generateVerificationCode, getBotFatherURL } from './lib/telegram.mjs';
import { confirm, keepOrReconfigure, generateTelegramWebhookSecret, promptForOptionalKey, maskSecret } from './lib/prompts.mjs';
import { updateEnvVariable } from './lib/auth.mjs';
import { runVerificationFlow } from './lib/telegram-verify.mjs';
import { loadEnvFile } from './lib/env.mjs';

const logo = `
 _____ _          ____                  ____        _
|_   _| |__   ___|  _ \\ ___  _ __   ___| __ )  ___ | |_
  | | | '_ \\ / _ \\ |_) / _ \\| '_ \\ / _ \\  _ \\ / _ \\| __|
  | | | | | |  __/  __/ (_) | |_) |  __/ |_) | (_) | |_
  |_| |_| |_|\\___|_|   \\___/| .__/ \\___|____/ \\___/ \\__|
                            |_|
`;

async function main() {
  console.log(chalk.cyan(logo));
  clack.intro('Telegram Setup');
  clack.log.info('Connect a Telegram bot to your agent. This wizard will walk you through creating a bot, registering a webhook, and linking your chat.');

  const TOTAL_STEPS = 6;
  let currentStep = 0;

  // Track values for summary
  let botUsername = null;
  let telegramChatId = null;

  // ─── Step 1: Prerequisites ──────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Checking prerequisites`);
  clack.log.info('Verifying git remote and loading existing configuration.');

  const prereqs = await checkPrerequisites();

  if (!prereqs.git.remoteInfo) {
    clack.log.error('Could not detect GitHub repository from git remote.');
    clack.cancel('Run setup first to initialize your repository.');
    process.exit(1);
  }

  const { owner, repo } = prereqs.git.remoteInfo;
  clack.log.success(`Repository: ${owner}/${repo}`);

  const env = loadEnvFile();

  if (env) {
    clack.log.info('Existing .env detected — previously configured values can be skipped.');
  }

  // ─── Step 2: Telegram Mode ──────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Telegram mode`);

  const existingMode = env?.TELEGRAM_MODE || null;
  let telegramMode = existingMode;

  if (!telegramMode || !(await keepOrReconfigure('TELEGRAM_MODE', existingMode))) {
    const mode = await clack.select({
      message: 'How should Telegram deliver messages?',
      options: [
        {
          label: 'Polling  (no public URL needed — bot polls Telegram)',
          value: 'polling',
          hint: 'Best for local/private networks. No ngrok or port forwarding required.',
        },
        {
          label: 'Webhook  (Telegram pushes to your public HTTPS URL)',
          value: 'webhook',
          hint: 'Requires a publicly accessible HTTPS endpoint.',
        },
      ],
      initialValue: existingMode || 'polling',
    });
    if (clack.isCancel(mode)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }
    telegramMode = mode;
  }

  updateEnvVariable('TELEGRAM_MODE', telegramMode);
  clack.log.success(`Mode: ${telegramMode}`);

  let appUrl = null;
  let webhookUrl = null;

  if (telegramMode === 'webhook') {
    // ─── Webhook mode: need APP_URL ──────────────────────────────────
    clack.log.info('Your bot needs a public HTTPS URL so Telegram can deliver messages to it via webhook.');
    clack.log.warn('Make sure your server is running and publicly accessible.');

    if (await keepOrReconfigure('APP_URL', env?.APP_URL || null)) {
      appUrl = env.APP_URL;
    }

    if (!appUrl) {
      clack.log.info(
        'Enter the public URL where your agent is running.\n' +
        '  Examples:\n' +
        '    ngrok: https://abc123.ngrok.io\n' +
        '    VPS:   https://mybot.example.com\n' +
        '    PaaS:  https://mybot.vercel.app'
      );

      while (!appUrl) {
        const url = await clack.text({
          message: 'Enter your APP_URL (https://...):',
          validate: (input) => {
            if (!input) return 'URL is required';
            if (!input.startsWith('https://')) return 'URL must start with https://';
          },
        });
        if (clack.isCancel(url)) {
          clack.cancel('Setup cancelled.');
          process.exit(0);
        }
        appUrl = url.replace(/\/$/, '');
      }
    }

    // Update APP_URL and APP_HOSTNAME in .env
    const appHostname = new URL(appUrl).hostname;
    updateEnvVariable('APP_URL', appUrl);
    updateEnvVariable('APP_HOSTNAME', appHostname);
    clack.log.success('APP_URL saved to .env');

    // Set APP_URL variable on GitHub
    const urlSpinner = clack.spinner();
    urlSpinner.start('Updating APP_URL variable on GitHub...');
    const urlResult = await setVariables(owner, repo, { APP_URL: appUrl });
    if (urlResult.APP_URL.success) {
      urlSpinner.stop('APP_URL variable updated on GitHub');
    } else {
      urlSpinner.stop(`Failed: ${urlResult.APP_URL.error}`);
    }
  } else {
    clack.log.success('Polling mode — no public URL needed. The bot will poll Telegram for updates.');
  }

  // ─── Step 3: Bot Token ──────────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Telegram Bot Token`);
  clack.log.info('Your agent needs a Telegram bot token from @BotFather to send and receive messages.');

  let token = null;

  if (await keepOrReconfigure('Telegram Bot', env?.TELEGRAM_BOT_TOKEN ? maskSecret(env.TELEGRAM_BOT_TOKEN) : null)) {
    // Validate existing token
    token = env.TELEGRAM_BOT_TOKEN;
    const validateSpinner = clack.spinner();
    validateSpinner.start('Validating existing bot token...');
    const validation = await validateBotToken(token);
    if (validation.valid) {
      botUsername = validation.botInfo.username;
      validateSpinner.stop(`Bot: @${botUsername}`);
    } else {
      validateSpinner.stop(`Invalid token in .env: ${validation.error}`);
      clack.log.warn('Existing token is invalid — you\'ll need to enter a new one.');
      token = null;
    }
  }

  if (!token) {
    clack.log.info(
      'Create a Telegram bot via @BotFather:\n' +
      '  1. Open @BotFather in Telegram\n' +
      '  2. Send /newbot and follow the prompts\n' +
      '  3. Copy the bot token'
    );

    const openBotFather = await confirm('Open BotFather in browser?');
    if (openBotFather) {
      await open(getBotFatherURL());
    }

    let tokenValid = false;
    while (!tokenValid) {
      const inputToken = await clack.password({
        message: 'Telegram bot token:',
        validate: (input) => {
          if (!input) return 'Token is required';
          if (!/^\d+:[A-Za-z0-9_-]+$/.test(input)) {
            return 'Invalid format. Should be like 123456789:ABC-DEF...';
          }
        },
      });
      if (clack.isCancel(inputToken)) {
        clack.cancel('Setup cancelled.');
        process.exit(0);
      }

      const validateSpinner = clack.spinner();
      validateSpinner.start('Validating bot token...');
      const validation = await validateBotToken(inputToken);

      if (!validation.valid) {
        validateSpinner.stop(`Invalid token: ${validation.error}`);
        continue;
      }

      token = inputToken;
      botUsername = validation.botInfo.username;
      validateSpinner.stop(`Bot: @${botUsername}`);
      tokenValid = true;
    }
  }

  // Bug fix #146: save token to .env
  updateEnvVariable('TELEGRAM_BOT_TOKEN', token);

  // ─── Step 4: Webhook (webhook mode only) ────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Register Webhook`);

  if (telegramMode === 'webhook') {
    clack.log.info('Registering a webhook tells Telegram where to send messages for your bot.');

    // Handle webhook secret
    let webhookSecret = env?.TELEGRAM_WEBHOOK_SECRET;
    if (webhookSecret) {
      clack.log.success('Using existing webhook secret');
    } else {
      webhookSecret = await generateTelegramWebhookSecret();
      updateEnvVariable('TELEGRAM_WEBHOOK_SECRET', webhookSecret);
      clack.log.success('Generated webhook secret');
    }

    // Register Telegram webhook
    webhookUrl = `${appUrl}/api/telegram/webhook`;
    const tgSpinner = clack.spinner();
    tgSpinner.start('Registering Telegram webhook...');
    const tgResult = await setTelegramWebhook(token, webhookUrl, webhookSecret);
    if (tgResult.ok) {
      tgSpinner.stop('Telegram webhook registered');
    } else {
      tgSpinner.stop(`Failed: ${tgResult.description}`);
    }
  } else {
    // Polling mode — delete any existing webhook
    clack.log.info('Polling mode — clearing any existing webhook...');
    const { deleteTelegramWebhook } = await import('./lib/telegram.mjs');
    const delResult = await deleteTelegramWebhook(token);
    if (delResult.ok) {
      clack.log.success('Webhook cleared — bot will use polling');
    } else {
      clack.log.warn(`Could not clear webhook: ${delResult.description || 'unknown error'}`);
    }
  }

  // ─── Step 5: Chat Verification ──────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Chat Verification`);
  clack.log.info('Link the bot to your Telegram chat so it only responds to you.');

  telegramChatId = env?.TELEGRAM_CHAT_ID || null;

  if (await keepOrReconfigure('Chat ID', telegramChatId)) {
    // Keep existing — already set
  } else {
    telegramChatId = null;
    const verificationCode = generateVerificationCode();
    updateEnvVariable('TELEGRAM_VERIFICATION', verificationCode);

    clack.log.warn('Waiting for server to restart with new verification code...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const chatId = await runVerificationFlow(verificationCode, { allowSkip: true });

    if (chatId) {
      telegramChatId = chatId;
      updateEnvVariable('TELEGRAM_CHAT_ID', chatId);
      clack.log.success(`Chat ID saved: ${chatId}`);
    } else {
      clack.log.warn('Chat ID is required — the bot will not respond without it.');
      clack.log.info('Run npm run setup-telegram again to complete setup.');
    }
  }

  // ─── Step 6: Optional Keys ──────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Optional Keys`);
  clack.log.info('An OpenAI API key enables voice message transcription via Whisper.');

  if (await keepOrReconfigure('OpenAI key', env?.OPENAI_API_KEY ? maskSecret(env.OPENAI_API_KEY) : null)) {
    // Keep existing
  } else {
    const openaiKey = await promptForOptionalKey('openai', 'voice messages');
    if (openaiKey) {
      updateEnvVariable('OPENAI_API_KEY', openaiKey);
      const s = clack.spinner();
      s.start('Setting OpenAI secret on GitHub...');
      await setSecrets(owner, repo, { AGENT_OPENAI_API_KEY: openaiKey });
      s.stop('OpenAI secret set');
      clack.log.success(`OpenAI key added for voice (${maskSecret(openaiKey)})`);
    }
  }

  // ─── Summary ────────────────────────────────────────────────────────
  let summary = '';
  summary += `Mode:      ${telegramMode}\n`;
  summary += `Bot:       @${botUsername || '(unknown)'}\n`;
  if (telegramMode === 'webhook') {
    summary += `Webhook:   ${webhookUrl}\n`;
  }
  summary += `Chat ID:   ${telegramChatId || '(not set)'}`;
  clack.note(summary, 'Telegram Configuration');

  clack.outro('Telegram setup complete!');
}

main().catch((error) => {
  clack.log.error(`Failed: ${error.message}`);
  process.exit(1);
});
