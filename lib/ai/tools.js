import fs from 'fs';
import path from 'path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createJob } from '../tools/create-job.js';
import { getJobStatus } from '../tools/github.js';
import { claudeMd, skillGuidePath, skillsDir } from '../paths.js';
import { isTokenBudgetEnabled, truncate, getMaxToolOutputChars } from './token-budget.js';
import { loadPersonasRegistry as _loadPersonasRegistry, delegateToPersona } from './personas.js';
import { searchChatHistory, formatResults } from '../rag/index.js';

/**
 * Truncate a tool result string when the token budget feature is enabled.
 * @param {string} text
 * @returns {string}
 */
function maybeTruncate(text) {
  if (!isTokenBudgetEnabled()) return text;
  return truncate(text, getMaxToolOutputChars());
}

const createJobTool = tool(
  async ({ job_description }) => {
    const result = await createJob(job_description);
    return JSON.stringify({
      success: true,
      job_id: result.job_id,
      branch: result.branch,
      title: result.title,
    });
  },
  {
    name: 'create_job',
    description:
      'Create an autonomous job that runs a Docker agent in a container. The Docker agent has full filesystem access, web search, browser automation, and other abilities. The job description you provide becomes the Docker agent\'s task prompt. Returns the job ID and branch name.',
    schema: z.object({
      job_description: z
        .string()
        .describe(
          'Detailed job description including context and requirements. Be specific about what needs to be done.'
        ),
    }),
  }
);

const getJobStatusTool = tool(
  async ({ job_id }) => {
    const result = await getJobStatus(job_id);
    return JSON.stringify(result);
  },
  {
    name: 'get_job_status',
    description:
      'Check status of running jobs. Returns list of active workflow runs with timing and current step. Use when user asks about job progress, running jobs, or job status.',
    schema: z.object({
      job_id: z
        .string()
        .optional()
        .describe(
          'Optional: specific job ID to check. If omitted, returns all running jobs.'
        ),
    }),
  }
);

const getSystemTechnicalSpecsTool = tool(
  async () => {
    try {
      return maybeTruncate(fs.readFileSync(claudeMd, 'utf8'));
    } catch {
      return 'No technical documentation found (CLAUDE.md not present in project root).';
    }
  },
  {
    name: 'get_system_technical_specs',
    description:
      'Read the system architecture and technical documentation (CLAUDE.md). You MUST call this before modifying any config file (CRONS.json, TRIGGERS.json, etc.) or system infrastructure — config entries have advanced fields (per-entry LLM overrides, webhook options, etc.) that are only documented here. Also use this when you need to understand how the system works — event handler, Docker agent, API routes, database, GitHub Actions, deployment, or file structure. NOT for skill creation (use get_skill_building_guide for that).',
    schema: z.object({}),
  }
);

/**
 * Scan skills/ for all skill directories and build an inventory
 * showing which are active vs available (inactive).
 */
function loadSkillInventory() {
  const activeDir = path.join(skillsDir, 'active');
  const SKIP = new Set(['active', 'LICENSE', 'README.md', '.git', '.github']);

  try {
    // Get all skill directories
    const allEntries = fs.existsSync(skillsDir)
      ? fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter(e => (e.isDirectory() || e.isSymbolicLink()) && !SKIP.has(e.name))
      : [];

    // Get active skill names
    const activeNames = new Set();
    if (fs.existsSync(activeDir)) {
      for (const entry of fs.readdirSync(activeDir, { withFileTypes: true })) {
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          activeNames.add(entry.name);
        }
      }
    }

    // Read frontmatter for each skill
    const skills = [];
    for (const entry of allEntries) {
      const skillMdPath = path.join(skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      const content = fs.readFileSync(skillMdPath, 'utf8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) continue;

      const frontmatter = frontmatterMatch[1];
      const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
      const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

      skills.push({
        dirName: entry.name,
        name: nameMatch ? nameMatch[1].trim() : entry.name,
        description: descMatch ? descMatch[1].trim() : 'No description',
        active: activeNames.has(entry.name),
      });
    }

    if (skills.length === 0) return '';

    const active = skills.filter(s => s.active);
    const inactive = skills.filter(s => !s.active);

    let inventory = '## Current Skills\n\n';

    if (active.length > 0) {
      inventory += '### Active\n';
      for (const s of active) {
        inventory += `- **${s.dirName}** — ${s.description}\n`;
      }
      inventory += '\n';
    }

    if (inactive.length > 0) {
      inventory += '### Available (not active)\n';
      for (const s of inactive) {
        inventory += `- **${s.dirName}** — ${s.description}\n`;
      }
      inventory += '\n';
    }

    inventory += 'Use `get_skill_details` with a skill name to read its full documentation, setup requirements, and usage.\n\n---\n\n';

    return inventory;
  } catch {
    return '';
  }
}

const getSkillBuildingGuideTool = tool(
  async () => {
    const inventory = loadSkillInventory();
    try {
      const guide = fs.readFileSync(skillGuidePath, 'utf8');
      return maybeTruncate(inventory + guide);
    } catch {
      return maybeTruncate(inventory) || 'Skill guide not found.';
    }
  },
  {
    name: 'get_skill_building_guide',
    description:
      'Load the skill building guide and a full inventory of all skills (active and available-but-inactive). You MUST call this before creating or modifying any skill — the guide contains required file structure, naming conventions, SKILL.md frontmatter format, activation steps, and testing procedures that are only documented there. Also use this when you need to check what skills already exist — it shows both active and inactive skills with descriptions. Skills are lightweight bash/Node.js wrappers in `skills/` that extend what agents can do. NOT for understanding the system architecture (use get_system_technical_specs for that).',
    schema: z.object({}),
  }
);

const getSkillDetailsTool = tool(
  async ({ skill_name }) => {
    const skillMdPath = path.join(skillsDir, skill_name, 'SKILL.md');
    try {
      return maybeTruncate(fs.readFileSync(skillMdPath, 'utf8'));
    } catch {
      return `Skill "${skill_name}" not found. Use get_skill_building_guide to see available skills.`;
    }
  },
  {
    name: 'get_skill_details',
    description:
      'Read the full documentation for a specific skill by name. Returns the complete SKILL.md including setup requirements, usage examples, and credential needs. Use this to understand what a skill does before suggesting it to the user, or to get credential setup details. Works with both active and inactive skills.',
    schema: z.object({
      skill_name: z.string(),
    }),
  }
);

/**
 * Create a start_coding tool bound to a specific workspace context.
 * @param {object} context
 * @param {string} context.repo - GitHub repo (e.g. "owner/repo")
 * @param {string} context.branch - Git branch
 * @param {string} context.workspaceId - Pre-created workspace row ID
 * @returns {import('@langchain/core/tools').StructuredTool}
 */
function createStartCodingTool({ repo, branch, workspaceId }) {
  return tool(
    async ({ task_description }) => {
      try {
        const { randomUUID } = await import('crypto');
        const containerName = `code-workspace-${randomUUID().slice(0, 8)}`;

        const { getCodeWorkspaceById, updateContainerName } = await import('../db/code-workspaces.js');
        const workspace = getCodeWorkspaceById(workspaceId);
        const codingAgent = workspace?.codingAgent || 'claude-code';
        const featureBranch = workspace?.featureBranch;

        const { createCodeWorkspaceContainer } = await import('../tools/docker.js');
        await createCodeWorkspaceContainer({ containerName, repo, branch, codingAgent, featureBranch, workspaceId });

        updateContainerName(workspaceId, containerName);

        return JSON.stringify({
          success: true,
          workspaceId,
          workspaceUrl: `/code/${workspaceId}`,
        });
      } catch (err) {
        console.error('[start_coding] Failed to launch workspace:', err);
        return JSON.stringify({
          success: false,
          error: err.message || 'Failed to launch workspace',
        });
      }
    },
    {
      name: 'start_coding',
      description:
        'Launch a live code workspace in a Docker container. Only call this when the user explicitly says they are ready to start coding (e.g. "let\'s start coding", "okay let\'s get started", "launch it"). Returns a link to the live workspace.',
      schema: z.object({
        task_description: z.string(),
      }),
    }
  );
}

/**
 * Create a get_repository_details tool bound to a specific repo/branch.
 * Fetches CLAUDE.md and README.md from the repo via GitHub API.
 * @param {object} context
 * @param {string} context.repo - GitHub repo (e.g. "owner/repo")
 * @param {string} context.branch - Git branch
 * @returns {import('@langchain/core/tools').StructuredTool}
 */
function createGetRepositoryDetailsTool({ repo, branch }) {
  return tool(
    async () => {
      const { githubApi } = await import('../tools/github.js');
      const files = ['CLAUDE.md', 'README.md'];
      const results = {};

      for (const file of files) {
        try {
          const data = await githubApi(`/repos/${repo}/contents/${file}?ref=${branch}`);
          results[file] = maybeTruncate(Buffer.from(data.content, 'base64').toString('utf8'));
        } catch {
          results[file] = 'Not found';
        }
      }

      return JSON.stringify(results);
    },
    {
      name: 'get_repository_details',
      description:
        'Fetch CLAUDE.md and README.md from the selected repository and branch. Call this as your first action when the user sends their first message to understand the project context.',
      schema: z.object({}),
    }
  );
}

/**
 * Create a start_headless_coding tool bound to a specific workspace context.
 * Launches an ephemeral headless container that runs a task, commits, and merges back.
 * @param {object} context
 * @param {string} context.repo - GitHub repo
 * @param {string} context.branch - Base branch
 * @param {string} context.workspaceId - Pre-created workspace row ID
 * @returns {import('@langchain/core/tools').StructuredTool}
 */
function createStartHeadlessCodingTool({ repo, branch, workspaceId }) {
  return tool(
    async ({ task_description }) => {
      try {
        const { randomUUID } = await import('crypto');
        const containerName = `code-headless-${randomUUID().slice(0, 8)}`;

        const { getCodeWorkspaceById } = await import('../db/code-workspaces.js');
        const workspace = getCodeWorkspaceById(workspaceId);
        const featureBranch = workspace?.featureBranch || `thepopebot/new-chat-${workspaceId.replace(/-/g, '').slice(0, 8)}`;

        const { createHeadlessCodeContainer } = await import('../tools/docker.js');

        await createHeadlessCodeContainer({
          containerName, repo, branch, featureBranch, workspaceId,
          taskPrompt: task_description,
        });

        return JSON.stringify({
          success: true,
          status: 'started',
          containerName,
          featureBranch,
        });
      } catch (err) {
        console.error('[start_headless_coding] Failed:', err);
        return JSON.stringify({
          success: false,
          error: err.message || 'Failed to launch headless coding task',
        });
      }
    },
    {
      name: 'start_headless_coding',
      description:
        'Launch a headless coding task in a Docker container. The task runs Claude Code, commits changes, and merges back automatically. Returns immediately after launching — output streams live in the chat. Use this as the default when the user wants to implement something.',
      schema: z.object({
        task_description: z.string().describe(
          'Detailed description of the coding task. Include context, requirements, and any specific instructions.'
        ),
      }),
    }
  );
}

/**
 * Create a get_branch_file tool bound to a specific repo/branch.
 * Fetches a single file from the feature branch via GitHub Contents API.
 * @param {object} context
 * @param {string} context.repo - GitHub repo (e.g. "owner/repo")
 * @param {string} context.branch - Feature branch name
 * @returns {import('@langchain/core/tools').StructuredTool}
 */
function createGetBranchFileTool({ repo, branch }) {
  return tool(
    async ({ file_path }) => {
      try {
        const { githubApi } = await import('../tools/github.js');
        const data = await githubApi(`/repos/${repo}/contents/${file_path}?ref=${branch}`);
        return maybeTruncate(Buffer.from(data.content, 'base64').toString('utf8'));
      } catch (err) {
        return `Error fetching ${file_path}: ${err.message || 'File not found'}`;
      }
    },
    {
      name: 'get_branch_file',
      description:
        'Fetch the contents of a specific file from the feature branch. Use this to inspect code changes, review implementations, or understand what was modified during a coding session.',
      schema: z.object({
        file_path: z.string().describe('Path to the file relative to the repository root (e.g. "src/index.js")'),
      }),
    }
  );
}

/**
 * Create a delegate_to_persona LangChain tool.
 * Wraps delegateToPersona() from lib/ai/personas.js.
 *
 * @param {object} [opts={}]
 * @param {string} [opts.registryPath] - Override PERSONAS.json path (for testing)
 */
function createDelegateToPersonaTool({ registryPath } = {}) {
  return tool(
    async ({ persona, message, thread_id }) => {
      const result = await delegateToPersona(persona, message, thread_id, { registryPath });
      return JSON.stringify(result);
    },
    {
      name: 'delegate_to_persona',
      description:
        "Delegate a task to another persona. The persona will process the message and return a response. Use this when you want a specialized persona (e.g., a worker) to handle a sub-task. Returns the persona's response.",
      schema: z.object({
        persona: z.string().describe('Name of the persona to delegate to (must exist in PERSONAS.json)'),
        message: z.string().describe('The task or question to send to the persona'),
        thread_id: z
          .string()
          .optional()
          .describe('Optional thread ID for conversation continuity with the delegated persona'),
      }),
    }
  );
}

const searchChatHistoryTool = tool(
  async ({ query, limit, exclude_current_chat_id }) => {
    const results = searchChatHistory(query, {
      limit: Math.min(limit ?? 5, 20),
      excludeChatId: exclude_current_chat_id,
    });
    return formatResults(results);
  },
  {
    name: 'search_chat_history',
    description:
      'Search past chat conversations for relevant context. Use when the user references something discussed previously, asks "remember when...", wants to revisit past decisions, or when you need context from earlier conversations to give a better answer. Returns ranked snippets from matching messages.',
    schema: z.object({
      query: z.string().describe('Search terms to find relevant past conversations. Use natural language keywords.'),
      limit: z.number().optional().describe('Max results to return (default: 5, max: 20)'),
      exclude_current_chat_id: z.string().optional().describe('Chat ID to exclude from results (pass the current thread ID to avoid redundant results from the ongoing conversation)'),
    }),
  }
);

export { createJobTool, getJobStatusTool, getSystemTechnicalSpecsTool, getSkillBuildingGuideTool, getSkillDetailsTool, createStartCodingTool, createStartHeadlessCodingTool, createGetRepositoryDetailsTool, createGetBranchFileTool, createDelegateToPersonaTool, searchChatHistoryTool };
export { _loadPersonasRegistry as loadPersonasRegistry };
