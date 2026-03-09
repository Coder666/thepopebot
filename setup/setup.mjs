#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import open from 'open';
import * as clack from '@clack/prompts';

import { createDirLink } from './lib/fs-utils.mjs';

import {
  checkPrerequisites,
  runGhAuth,
} from './lib/prerequisites.mjs';
import {
  promptForPAT,
  promptForProvider,
  promptForModel,
  promptForApiKey,
  promptForCustomProvider,
  promptForBraveKey,
  confirm,
  pressEnter,
  maskSecret,
  keepOrReconfigure,
} from './lib/prompts.mjs';
import { PROVIDERS } from './lib/providers.mjs';
import {
  validatePAT,
  checkPATScopes,
  generateWebhookSecret,
  getPATCreationURL,
  setSecret,
  setVariable,
} from './lib/github.mjs';
import { writeModelsJson, updateEnvVariable } from './lib/auth.mjs';
import { loadEnvFile } from './lib/env.mjs';
import { syncConfig } from './lib/sync.mjs';

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
  clack.intro('Interactive Setup Wizard');

  const TOTAL_STEPS = 8;
  let currentStep = 0;

  // Load existing .env (always exists after init — seed .env has AUTH_SECRET etc.)
  const env = loadEnvFile();

  if (env) {
    clack.log.info('Existing .env detected — previously configured values can be skipped.');
  }

  // Flat object collecting all config values for sync
  const collected = {};
  let owner = null;
  let repo = null;

  // ─── Step 1: Prerequisites ───────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Checking prerequisites`);
  clack.log.info('Your agent needs a few tools installed on your machine. Let\'s make sure everything is ready.');

  const s = clack.spinner();
  s.start('Checking system requirements...');
  const prereqs = await checkPrerequisites();
  s.stop('Prerequisites checked');

  // Node.js
  if (prereqs.node.ok) {
    clack.log.success(`Node.js ${prereqs.node.version}`);
  } else if (prereqs.node.installed) {
    clack.log.error(`Node.js ${prereqs.node.version} (need >= 18)`);
    clack.cancel('Please upgrade Node.js to version 18 or higher.');
    process.exit(1);
  } else {
    clack.log.error('Node.js not found');
    clack.cancel('Please install Node.js 18+: https://nodejs.org');
    process.exit(1);
  }

  // Package manager
  if (prereqs.packageManager.installed) {
    clack.log.success(`Package manager: ${prereqs.packageManager.name}`);
  } else {
    clack.log.error('No package manager found (need pnpm or npm)');
    process.exit(1);
  }

  // Git
  if (!prereqs.git.installed) {
    clack.log.error('Git not found');
    process.exit(1);
  }
  clack.log.success('Git installed');

  // gh CLI
  if (prereqs.gh.installed) {
    if (prereqs.gh.authenticated) {
      clack.log.success('GitHub CLI authenticated');
    } else {
      clack.log.warn('GitHub CLI installed but not authenticated');
      const shouldAuth = await confirm('Run gh auth login now?');
      if (shouldAuth) {
        try {
          runGhAuth();
          clack.log.success('GitHub CLI authenticated');
        } catch {
          clack.log.error('Failed to authenticate gh CLI');
          process.exit(1);
        }
      } else {
        clack.log.error('GitHub CLI authentication required');
        process.exit(1);
      }
    }
  } else {
    clack.log.error('GitHub CLI (gh) not found');
    const installCmd = process.platform === 'darwin'
      ? 'brew install gh'
      : process.platform === 'win32'
        ? 'winget install GitHub.cli'
        : 'sudo apt install gh  (or see https://github.com/cli/cli#installation)';
    clack.log.info(`Install the GitHub CLI, then re-run setup:\n\n  ${installCmd}\n`);
    clack.cancel('Missing prerequisite: gh CLI');
    process.exit(1);
  }

  // Initialize git repo if needed
  if (!prereqs.git.initialized) {
    const initSpinner = clack.spinner();
    initSpinner.start('Initializing git repo...');
    execSync('git init', { stdio: 'ignore' });
    initSpinner.stop('Git repo initialized');
  }

  if (prereqs.git.remoteInfo) {
    owner = prereqs.git.remoteInfo.owner;
    repo = prereqs.git.remoteInfo.repo;
    clack.log.success(`Repository: ${owner}/${repo}`);
  } else {
    clack.log.warn('No GitHub remote detected. We\'ll set one up.');

    // Stage and commit
    execSync('git add .', { stdio: 'ignore' });
    try {
      execSync('git diff --cached --quiet', { stdio: 'ignore' });
      clack.log.success('Nothing new to commit');
    } catch {
      const commitSpinner = clack.spinner();
      commitSpinner.start('Creating initial commit...');
      try {
        execSync('git commit -m "initial commit [skip ci]"', { stdio: 'pipe' });
        commitSpinner.stop('Created initial commit');
      } catch (commitErr) {
        commitSpinner.stop('Commit failed');
        const msg = commitErr.stderr?.toString() || commitErr.message || '';
        if (msg.includes('Author identity unknown') || msg.includes('user.email') || msg.includes('user.name')) {
          clack.log.error('Git user identity is not configured.');
          clack.log.info('Run these commands then re-run setup:');
          clack.log.info('  git config --global user.email "you@example.com"');
          clack.log.info('  git config --global user.name "Your Name"');
        } else {
          clack.log.error(`Commit failed: ${msg.trim() || commitErr.message}`);
        }
        clack.cancel('Setup cancelled.');
        process.exit(1);
      }
    }

    // Ask for project name
    const dirName = path.basename(process.cwd());
    const projectName = await clack.text({
      message: 'Name your project:',
      initialValue: dirName,
      validate: (input) => {
        if (!input) return 'Name is required';
      },
    });
    if (clack.isCancel(projectName)) {
      clack.cancel('Setup cancelled.');
      process.exit(0);
    }

    clack.log.info('Create a GitHub repo:');
    clack.log.info('  1. Create a new private repository');
    clack.log.info('  2. Do NOT initialize with a README');
    clack.log.info('  3. Copy the HTTPS URL');

    const openGitHub = await confirm('Open GitHub repo creation page in browser?');
    if (openGitHub) {
      await open(`https://github.com/new?name=${encodeURIComponent(projectName)}&visibility=private`);
      clack.log.info('Opened in browser (name and private pre-filled).');
    }

    // Ask for the remote URL and add it
    let remoteAdded = false;
    while (!remoteAdded) {
      const remoteUrl = await clack.text({
        message: 'Paste the HTTPS repository URL:',
        validate: (input) => {
          if (!input) return 'URL is required';
          if (!input.startsWith('https://github.com/')) return 'Must be an HTTPS GitHub URL (https://github.com/...)';
        },
      });
      if (clack.isCancel(remoteUrl)) {
        clack.cancel('Setup cancelled.');
        process.exit(0);
      }

      try {
        const url = remoteUrl.replace(/\/$/, '').replace(/\.git$/, '') + '.git';
        execSync(`git remote add origin "${url}"`, { stdio: 'ignore' });
        remoteAdded = true;
      } catch {
        try {
          const url = remoteUrl.replace(/\/$/, '').replace(/\.git$/, '') + '.git';
          execSync(`git remote set-url origin "${url}"`, { stdio: 'ignore' });
          remoteAdded = true;
        } catch {
          clack.log.error('Failed to set remote. Try again.');
        }
      }
    }

    const { getGitRemoteInfo } = await import('./lib/prerequisites.mjs');
    const remoteInfo = getGitRemoteInfo();
    if (remoteInfo) {
      owner = remoteInfo.owner;
      repo = remoteInfo.repo;
      clack.log.success(`Repository: ${owner}/${repo}`);
    } else {
      clack.log.error('Could not detect repository from remote.');
      process.exit(1);
    }
  }

  // Add owner/repo to collected
  collected.GH_OWNER = owner;
  collected.GH_REPO = repo;

  // Track whether we need to push after getting the PAT
  let needsPush = false;
  try {
    execSync('git rev-parse --verify origin/main', { stdio: 'ignore' });
  } catch {
    needsPush = true;
  }

  // ngrok check (informational only)
  if (prereqs.ngrok.installed) {
    clack.log.success('ngrok installed');
  } else {
    clack.log.warn('ngrok not installed (needed to expose local server)');
    const ngrokInstallCmd = process.platform === 'win32'
      ? 'winget install ngrok.ngrok'
      : process.platform === 'darwin'
        ? 'brew install ngrok/ngrok/ngrok'
        : 'See https://ngrok.com/download';
    clack.log.info(
      `Install with: ${ngrokInstallCmd}\n` +
      '  Sign up for a free account at https://dashboard.ngrok.com/signup\n' +
      '  Then run: ngrok config add-authtoken <YOUR_TOKEN>'
    );
  }

  // ─── Step 2: GitHub PAT ──────────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] GitHub Personal Access Token`);
  clack.log.info('Your agent needs permission to create branches and pull requests in your GitHub repo. A Personal Access Token (PAT) grants this access.');

  let pat = null;
  if (await keepOrReconfigure('GitHub PAT', env?.GH_TOKEN ? maskSecret(env.GH_TOKEN) : null)) {
    pat = env.GH_TOKEN;
  }

  if (!pat) {
    clack.log.info(
      `Create a fine-grained PAT scoped to ${owner}/${repo} only:\n` +
      `  Repository access: Only select repositories > ${owner}/${repo}\n` +
      '  Actions: Read and write\n' +
      '  Administration: Read and write (required for self-hosted runners)\n' +
      '  Contents: Read and write\n' +
      '  Metadata: Read-only (required, auto-selected)\n' +
      '  Pull requests: Read and write\n' +
      '  Workflows: Read and write'
    );

    const openPATPage = await confirm('Open GitHub PAT creation page in browser?');
    if (openPATPage) {
      await open(getPATCreationURL());
      clack.log.info(`Opened in browser. Scope it to ${owner}/${repo} only.`);
    }

    let patValid = false;
    while (!patValid) {
      pat = await promptForPAT();

      const validateSpinner = clack.spinner();
      validateSpinner.start('Validating PAT...');
      const validation = await validatePAT(pat);

      if (!validation.valid) {
        validateSpinner.stop(`Invalid PAT: ${validation.error}`);
        continue;
      }

      const scopes = await checkPATScopes(pat);
      if (!scopes.hasRepo || !scopes.hasWorkflow) {
        validateSpinner.stop('PAT missing required scopes');
        clack.log.info(`Found scopes: ${scopes.scopes.join(', ') || 'none'}`);
        continue;
      }

      if (scopes.isFineGrained) {
        validateSpinner.stop(`Fine-grained PAT valid for user: ${validation.user}`);
      } else {
        validateSpinner.stop(`PAT valid for user: ${validation.user}`);
      }
      patValid = true;
    }
  }

  collected.GH_TOKEN = pat;

  // Push to GitHub now that we have the PAT
  if (needsPush) {
    const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();

    let pushed = false;
    while (!pushed) {
      const authedUrl = remote.replace('https://github.com/', `https://x-access-token:${pat}@github.com/`);
      execSync(`git remote set-url origin "${authedUrl}"`, { stdio: 'ignore' });

      const pushSpinner = clack.spinner();
      pushSpinner.start('Pushing to GitHub...');
      try {
        execSync('git branch -M main', { stdio: 'ignore' });
        execSync('git push -u origin main 2>&1', { encoding: 'utf-8' });
        pushSpinner.stop('Pushed to GitHub');
        pushed = true;
      } catch (err) {
        pushSpinner.stop('Failed to push');
        const output = (err.stdout || '') + (err.stderr || '');
        if (output) clack.log.error(output.trim());
        execSync(`git remote set-url origin "${remote}"`, { stdio: 'ignore' });
        clack.log.info('Your PAT may not have write access to this repository.');
        pat = await promptForPAT();
        collected.GH_TOKEN = pat;
        continue;
      }

      // Reset remote URL back to clean HTTPS (no token embedded)
      execSync(`git remote set-url origin "${remote}"`, { stdio: 'ignore' });
    }
  }

  // ─── Step 3: API Keys ────────────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] API Keys`);
  clack.log.info('Your agent uses a large language model (LLM) to think and write code. You\'ll choose a provider and enter an API key from them.');

  // Step 3a: Chat LLM (event handler)
  let chatProvider = null;
  let chatModel = null;
  let openaiBaseUrl = null;

  // Agent LLM overrides (only set when user chooses different agent config)
  let agentProvider = null;
  let agentModel = null;

  // Build display string for existing LLM config
  let llmDisplay = null;
  if (env?.LLM_PROVIDER && env?.LLM_MODEL) {
    const existingEnvKey = env.LLM_PROVIDER === 'custom'
      ? 'CUSTOM_API_KEY'
      : PROVIDERS[env.LLM_PROVIDER]?.envKey;

    if (existingEnvKey) {
      const existingKey = env[existingEnvKey];
      const providerLabel = env.LLM_PROVIDER === 'custom'
        ? 'Local (OpenAI Compatible API)'
        : (PROVIDERS[env.LLM_PROVIDER]?.label || env.LLM_PROVIDER);
      llmDisplay = existingKey
        ? `${providerLabel} / ${env.LLM_MODEL} (${maskSecret(existingKey)})`
        : `${providerLabel} / ${env.LLM_MODEL}`;
      if ((env.LLM_PROVIDER === 'openai' || env.LLM_PROVIDER === 'custom') && env.OPENAI_BASE_URL) {
        llmDisplay += ` @ ${env.OPENAI_BASE_URL}`;
      }
    }
  }

  if (llmDisplay && await keepOrReconfigure('LLM', llmDisplay)) {
    // Keep existing LLM config
    chatProvider = env.LLM_PROVIDER;
    chatModel = env.LLM_MODEL;
    const existingEnvKey = chatProvider === 'custom'
      ? 'CUSTOM_API_KEY'
      : PROVIDERS[chatProvider].envKey;
    collected.LLM_PROVIDER = chatProvider;
    collected.LLM_MODEL = chatModel;
    collected[existingEnvKey] = env[existingEnvKey] || '';
    if (env.OPENAI_BASE_URL) {
      openaiBaseUrl = env.OPENAI_BASE_URL;
      collected.OPENAI_BASE_URL = openaiBaseUrl;
    }
    if (chatProvider === 'custom' && env.CONTEXT_WINDOW) {
      collected.CONTEXT_WINDOW = env.CONTEXT_WINDOW;
    }
  } else {
    // Prompt for new LLM config
    clack.log.info('Choose the LLM provider for your bot.');

    chatProvider = await promptForProvider();

    if (chatProvider === 'custom') {
      clack.log.info('If the model runs on this machine, use http://host.docker.internal:<port>/v1');
      clack.log.info('instead of localhost (localhost won\'t work from inside Docker)');
      clack.log.info('Ollama example: http://host.docker.internal:11434/v1');
      const custom = await promptForCustomProvider();
      chatModel = custom.model;
      openaiBaseUrl = custom.baseUrl;
      writeModelsJson('custom', {
        baseUrl: custom.baseUrl,
        apiKey: 'CUSTOM_API_KEY',
        api: 'openai-completions',
        models: [custom.model],
      });
      collected.CUSTOM_API_KEY = custom.apiKey || '';
      collected.OPENAI_BASE_URL = openaiBaseUrl;
      collected.CONTEXT_WINDOW = custom.contextWindow;
      clack.log.success(`Custom provider configured: ${custom.model} @ ${custom.baseUrl} (${custom.contextWindow} token context)`);
      if (custom.apiKey) {
        clack.log.success(`API key added (${maskSecret(custom.apiKey)})`);
      }
    } else {
      const providerConfig = PROVIDERS[chatProvider];
      chatModel = await promptForModel(chatProvider, { defaultModelId: 'claude-sonnet-4-6' });
      const chatApiKey = await promptForApiKey(chatProvider);
      collected[providerConfig.envKey] = chatApiKey;

      // Non-builtin providers need models.json
      if (!providerConfig.builtin) {
        writeModelsJson(chatProvider, {
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.envKey,
          api: providerConfig.api,
          models: providerConfig.models.map((m) => m.id),
        });
        clack.log.success(`Generated .pi/agent/models.json for ${providerConfig.name}`);
      }

      clack.log.success(`${providerConfig.name} key added (${maskSecret(chatApiKey)})`);
    }

    collected.LLM_PROVIDER = chatProvider;
    collected.LLM_MODEL = chatModel;

    if (chatProvider === 'custom') {
      collected.RUNS_ON = 'self-hosted';
    }
  }

  // Re-run: reconfigure existing OPENAI_BASE_URL if provider was kept
  if ((chatProvider === 'openai' || chatProvider === 'custom') && env?.OPENAI_BASE_URL && !collected.OPENAI_BASE_URL) {
    if (!await keepOrReconfigure('Custom LLM URL', env.OPENAI_BASE_URL)) {
      clack.log.info('If the model runs on this machine, use http://host.docker.internal:<port>/v1');
      clack.log.info('instead of localhost (localhost won\'t work from inside Docker)');
      clack.log.info('Ollama example: http://host.docker.internal:11434/v1');
      const baseUrl = await clack.text({
        message: 'API base URL:',
        validate: (input) => {
          if (!input) return 'URL is required';
          if (!input.startsWith('http://') && !input.startsWith('https://')) {
            return 'URL must start with http:// or https://';
          }
        },
      });
      if (clack.isCancel(baseUrl)) {
        clack.cancel('Setup cancelled.');
        process.exit(0);
      }
      openaiBaseUrl = baseUrl;
      collected.OPENAI_BASE_URL = openaiBaseUrl;
      clack.log.success(`Custom base URL: ${openaiBaseUrl}`);
    } else {
      openaiBaseUrl = env.OPENAI_BASE_URL;
      collected.OPENAI_BASE_URL = openaiBaseUrl;
    }
  }

  // Step 3b: Separate agent LLM settings
  const useDifferentAgent = await confirm(
    'Would you like agent jobs to use different LLM settings?\n  (Required if you want to use a Claude Pro/Max subscription for agent jobs)',
    false
  );

  if (useDifferentAgent) {
    clack.log.info('Choose the LLM provider for agent jobs.');

    agentProvider = await promptForProvider();

    if (agentProvider === 'custom') {
      // Custom/local agent — prompt for model ID directly
      const customModel = await clack.text({
        message: 'Enter agent model ID (e.g., qwen3:8b):',
        validate: (input) => { if (!input) return 'Model ID is required'; },
      });
      if (clack.isCancel(customModel)) { clack.cancel('Setup cancelled.'); process.exit(0); }
      agentModel = customModel;
      collected.RUNS_ON = 'self-hosted';
    } else {
      const agentProviderConfig = PROVIDERS[agentProvider];
      agentModel = await promptForModel(agentProvider);

      // Collect agent API key if different provider than chat
      if (agentProvider !== chatProvider) {
        const agentApiKey = await promptForApiKey(agentProvider);
        // Set agent API key as a GitHub secret directly — not added to collected
        // to avoid polluting .env with a key the event handler doesn't use
        collected['__agentApiKey'] = { provider: agentProvider, key: agentApiKey, secretName: `AGENT_${agentProviderConfig.envKey}` };
        clack.log.success(`Agent ${agentProviderConfig.name} key added (${maskSecret(agentApiKey)})`);
      }

      // OAuth prompt — only when agent provider is Anthropic
      if (agentProviderConfig.oauthSupported) {
        let skipOAuth = false;
        if (env?.CLAUDE_CODE_OAUTH_TOKEN) {
          skipOAuth = await keepOrReconfigure(
            'Claude OAuth Token',
            `${maskSecret(env.CLAUDE_CODE_OAUTH_TOKEN)} (agent backend: ${env.AGENT_BACKEND || 'claude-code'})`
          );
          if (skipOAuth) {
            collected.CLAUDE_CODE_OAUTH_TOKEN = env.CLAUDE_CODE_OAUTH_TOKEN;
            collected.AGENT_BACKEND = env.AGENT_BACKEND || 'claude-code';

            // OAuth replaces the API key for agent jobs — don't push it to GitHub.
            if (collected.ANTHROPIC_API_KEY) {
              updateEnvVariable('ANTHROPIC_API_KEY', collected.ANTHROPIC_API_KEY);
              delete collected.ANTHROPIC_API_KEY;
            }
            delete collected['__agentApiKey'];
          }
        }

        if (!skipOAuth) {
          const hasSub = await confirm('Do you have a Claude Pro or Max subscription?', false);

          if (hasSub) {
            clack.log.info(
              'You can use your subscription for agent jobs instead of API credits.\n' +
              '  This switches your job runner from Pi to Claude Code CLI.\n' +
              '  See docs/CLAUDE_CODE_VS_PI.md for details.\n\n' +
              '  Your API key will only be saved locally for chat — it won\'t be\n' +
              '  pushed to GitHub since agent jobs will use the OAuth token instead.'
            );

            // Check if claude CLI is installed
            let claudeInstalled = false;
            try {
              execSync('command -v claude', { stdio: 'ignore' });
              claudeInstalled = true;
            } catch {}

            if (claudeInstalled) {
              clack.log.info(
                'Generate your token by running this in another terminal:\n\n' +
                '    claude setup-token\n\n' +
                '  This opens your browser to authenticate with your Claude account.\n' +
                '  After auth, a 1-year token is printed to your terminal.'
              );
            } else {
              clack.log.info(
                'First, install the Claude Code CLI:\n\n' +
                '    npm install -g @anthropic-ai/claude-code\n\n' +
                '  Then run:\n\n' +
                '    claude setup-token\n\n' +
                '  This opens your browser to authenticate with your Claude account.\n' +
                '  After auth, a 1-year token is printed to your terminal.'
              );
            }

            let oauthToken = null;
            while (!oauthToken) {
              const tokenInput = await clack.password({
                message: 'Paste your token here (starts with sk-ant-oat01-):',
                validate: (input) => {
                  if (!input) return 'Token is required (or press Ctrl+C to skip)';
                  if (!input.startsWith('sk-ant-oat01-')) return 'Token must start with sk-ant-oat01-';
                },
              });
              if (clack.isCancel(tokenInput)) {
                clack.log.info('Skipped OAuth — agent jobs will use Pi with API credits.');
                break;
              }
              oauthToken = tokenInput.trim();
            }

            if (oauthToken) {
              collected.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
              collected.AGENT_BACKEND = 'claude-code';

              // OAuth replaces the API key for agent jobs — don't push it to GitHub.
              // The key is still needed in .env for the event handler chat, so write it directly.
              if (collected.ANTHROPIC_API_KEY) {
                updateEnvVariable('ANTHROPIC_API_KEY', collected.ANTHROPIC_API_KEY);
                delete collected.ANTHROPIC_API_KEY;
              }
              delete collected['__agentApiKey'];

              clack.log.success(`Claude OAuth token added (${maskSecret(oauthToken)})`);
              clack.log.info('Agent jobs will use Claude Code CLI with your subscription.');
            }
          }
        }
      }
    }
  }

  // Step 3c: Brave Search (optional — not in .env, always ask)
  const braveKey = await promptForBraveKey();
  if (braveKey) {
    collected.BRAVE_API_KEY = braveKey;
    clack.log.success(`Brave Search key added (${maskSecret(braveKey)})`);

    // Enable brave-search skill symlink
    const braveSymlink = path.join(process.cwd(), 'skills', 'active', 'brave-search');
    if (!fs.existsSync(braveSymlink)) {
      fs.mkdirSync(path.dirname(braveSymlink), { recursive: true });
      createDirLink('../brave-search', braveSymlink);
      clack.log.success('Enabled brave-search skill');

      // Commit and push the symlink so the Docker agent can use it
      try {
        execSync('git add skills/active/brave-search', { stdio: 'ignore' });
        execSync('git commit -m "enable brave-search skill [no ci]"', { stdio: 'ignore' });
        const remote = execSync('git remote get-url origin', { encoding: 'utf-8' }).trim();
        const authedUrl = remote.replace('https://github.com/', `https://x-access-token:${pat}@github.com/`);
        execSync(`git remote set-url origin "${authedUrl}"`, { stdio: 'ignore' });
        execSync('git push origin main', { stdio: 'ignore' });
        execSync(`git remote set-url origin "${remote}"`, { stdio: 'ignore' });
        clack.log.success('Pushed brave-search skill to GitHub');
      } catch {
        clack.log.warn('Could not push brave-search symlink — you may need to push manually');
      }
    }
  }

  // ─── Step 4: App URL ─────────────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] App URL`);
  clack.log.info('Your agent runs as a web server that receives notifications from GitHub when jobs finish. It needs a public URL to receive those webhooks.');

  let appUrl = null;

  if (await keepOrReconfigure('APP_URL', env?.APP_URL || null)) {
    appUrl = env.APP_URL;
  }

  if (!appUrl) {
    clack.log.info(
      'Your app needs a public URL so GitHub can send webhook notifications.\n' +
      '  Examples:\n' +
      '    ngrok: https://abc123.ngrok.io\n' +
      '    VPS:   https://mybot.example.com\n' +
      '    PaaS:  https://mybot.vercel.app'
    );

    while (!appUrl) {
      const urlInput = await clack.text({
        message: 'Enter your APP_URL (https://...):',
        validate: (input) => {
          if (!input) return 'URL is required';
          if (!input.startsWith('https://')) return 'URL must start with https://';
        },
      });
      if (clack.isCancel(urlInput)) {
        clack.cancel('Setup cancelled.');
        process.exit(0);
      }
      appUrl = urlInput.replace(/\/$/, '');
    }
  }

  collected.APP_URL = appUrl;
  collected.APP_HOSTNAME = new URL(appUrl).hostname;

  // Generate GH_WEBHOOK_SECRET if missing
  collected.GH_WEBHOOK_SECRET = env?.GH_WEBHOOK_SECRET || generateWebhookSecret();

  // ─── Step 5: Sync Config ─────────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Sync config`);

  if (!owner || !repo) {
    clack.log.warn('Could not detect repository. Please enter manually.');
    const ownerInput = await clack.text({ message: 'GitHub owner/org:' });
    if (clack.isCancel(ownerInput)) { clack.cancel('Setup cancelled.'); process.exit(0); }
    owner = ownerInput;
    const repoInput = await clack.text({ message: 'Repository name:' });
    if (clack.isCancel(repoInput)) { clack.cancel('Setup cancelled.'); process.exit(0); }
    repo = repoInput;
    collected.GH_OWNER = owner;
    collected.GH_REPO = repo;
  }

  // Extract agent API key info before sync (not a real config target)
  const agentApiKeyInfo = collected['__agentApiKey'];
  delete collected['__agentApiKey'];

  const report = await syncConfig(env, collected, { owner, repo });

  // If agent uses a different model/provider, overwrite the GitHub variable
  // (.env keeps chatModel for the event handler, GitHub variable gets agentModel for jobs)
  if (agentModel && agentModel !== chatModel) {
    await setVariable(owner, repo, 'LLM_MODEL', agentModel);
  }
  if (agentProvider && agentProvider !== chatProvider) {
    await setVariable(owner, repo, 'LLM_PROVIDER', agentProvider);
  }

  // Set agent API key as a separate GitHub secret (not in .env)
  if (agentApiKeyInfo) {
    const s2 = clack.spinner();
    s2.start('Setting agent API key secret...');
    const result = await setSecret(owner, repo, agentApiKeyInfo.secretName, agentApiKeyInfo.key);
    if (result.success) {
      s2.stop(`Agent secret ${agentApiKeyInfo.secretName} set`);
      report.secrets.push(agentApiKeyInfo.secretName);
    } else {
      s2.stop(`Failed to set agent secret: ${result.error}`);
    }
  }

  clack.log.info('Your agent includes a web chat interface at your APP_URL.');

  // ─── Step 6: Build ──────────────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Build`);

  // Helper: run build with retry on failure
  async function runBuildWithRetry() {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        fs.rmSync(path.join(process.cwd(), '.next'), { recursive: true, force: true });
        execSync('npm run build', { stdio: 'inherit' });
        clack.log.success('Build complete');
        return true;
      } catch {
        if (attempt === 1) {
          clack.log.error('Build failed.');
          const retry = await confirm('Retry build?');
          if (!retry) break;
        } else {
          clack.log.error('Build failed again.');
        }
      }
    }
    clack.log.error(
      'Cannot continue without a successful build.\n' +
      '  Fix the error above, then run:\n\n' +
      '    npm run build'
    );
    process.exit(1);
  }

  const hasExistingBuild = fs.existsSync(path.join(process.cwd(), '.next'));

  if (hasExistingBuild) {
    if (await confirm('Existing build found. Rebuild?')) {
      clack.log.info('Building Next.js...');
      await runBuildWithRetry();
    } else {
      clack.log.info('Skipping build');
    }
  } else {
    clack.log.info('Building Next.js...');
    await runBuildWithRetry();
  }

  // ─── Step 7: Start Server ─────────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Start Server`);

  let serverRunning = false;
  try {
    await fetch('http://localhost:80/api/ping', {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    serverRunning = true;
  } catch {
    // Server not reachable
  }

  if (serverRunning) {
    if (await confirm('Server is already running. Restart?')) {
      clack.log.info('Restarting server...');
      try {
        execSync('docker compose down && docker compose up -d', { stdio: 'inherit' });
        clack.log.success('Server restarted');
      } catch {
        clack.log.warn('Failed to restart. Run manually: docker compose down && docker compose up -d');
      }
    }
  } else {
    clack.log.info('Starting server...');
    try {
      execSync('docker compose up -d', { stdio: 'inherit' });
      clack.log.success('Server started');
    } catch {
      clack.log.warn('Failed to start. Run manually: docker compose up -d');
    }
  }

  clack.log.info(`Server starting — visit ${appUrl} (may take 10-20 seconds to load)`);

  // ─── Step 8: Summary ─────────────────────────────────────────────────
  clack.log.step(`[${++currentStep}/${TOTAL_STEPS}] Setup Complete!`);

  const chatProviderLabel = chatProvider === 'custom' ? 'Local (OpenAI Compatible API)' : PROVIDERS[chatProvider].label;

  let summary = '';
  summary += `Repository:   ${owner}/${repo}\n`;
  summary += `App URL:      ${appUrl}\n`;

  if (agentProvider || agentModel) {
    const agentProviderLabel = agentProvider
      ? (agentProvider === 'custom' ? 'Local (OpenAI Compatible API)' : PROVIDERS[agentProvider].label)
      : chatProviderLabel;
    const agentModelDisplay = agentModel || chatModel;
    summary += `Chat LLM:     ${chatProviderLabel} (${chatModel})  [.env]\n`;
    summary += `Agent LLM:    ${agentProviderLabel} (${agentModelDisplay})  [GitHub var]\n`;
  } else {
    summary += `LLM:          ${chatProviderLabel} (${chatModel})\n`;
  }

  if (collected.AGENT_BACKEND) {
    summary += `Agent Runner: ${collected.AGENT_BACKEND === 'claude-code' ? 'Claude Code CLI (subscription)' : 'Pi Coding Agent (API credits)'}\n`;
  }
  summary += `GitHub PAT:   ${maskSecret(pat)}`;

  clack.note(summary, 'Configuration');

  if (report.secrets.length > 0) {
    clack.log.info(`GitHub secrets set: ${report.secrets.join(', ')}`);
  }
  if (report.variables.length > 0) {
    clack.log.info(`GitHub variables set: ${report.variables.join(', ')}`);
  }

  clack.outro(`Chat with your agent at ${appUrl}`);
}

main().catch((error) => {
  clack.log.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
