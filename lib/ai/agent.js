import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { SystemMessage, trimMessages } from '@langchain/core/messages';
import { createModel } from './model.js';
import { createJobTool, getJobStatusTool, getSystemTechnicalSpecsTool, getSkillBuildingGuideTool, getSkillDetailsTool, createStartHeadlessCodingTool, createGetRepositoryDetailsTool, createGetBranchFileTool, createDelegateToPersonaTool, createCreateRepositoryTool, searchChatHistoryTool } from './tools.js';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { jobPlanningMd, codePlanningMd, thepopebotDb } from '../paths.js';
import { render_md } from '../utils/render-md.js';
import { createWebSearchTool, getProvider } from './web-search.js';
import { loadPersonaContent } from './personas.js';
import { isTokenBudgetEnabled, countTokens, messageTokenCounter, getContextWindow, getResponseReserve } from './token-budget.js';
import { isRagEnabled } from '../rag/index.js';

/**
 * Build a prompt function for createReactAgent that optionally trims the
 * message history to fit within the configured context window.
 *
 * Works with any LLM provider including local models (Ollama, LM Studio,
 * llama.cpp, etc.). When TOKEN_BUDGET_ENABLED is false the original
 * behaviour is preserved exactly.
 *
 * @param {string} mdPath - Absolute path to the system prompt markdown file
 * @param {object} [extraVars={}] - Extra variables passed to render_md (e.g., { soul: '...' })
 * @returns {Function} Async prompt function accepted by createReactAgent
 */
function makePrompt(mdPath, extraVars = {}) {
  return async (state) => {
    const systemContent = render_md(mdPath, [], extraVars);

    if (!isTokenBudgetEnabled()) {
      return [new SystemMessage(systemContent), ...state.messages];
    }

    const systemTokens = countTokens(systemContent);
    const budget = Math.max(0, getContextWindow() - systemTokens - getResponseReserve());

    const trimmed = await trimMessages(state.messages, {
      maxTokens: budget,
      tokenCounter: messageTokenCounter,
      strategy: 'last',
      includeSystem: false,
    });

    if (trimmed.length < state.messages.length) {
      console.log(
        `[token-budget] Trimmed ${state.messages.length - trimmed.length} messages ` +
        `to fit ${getContextWindow()}-token context window ` +
        `(system: ~${systemTokens} tokens, history budget: ${budget} tokens)`
      );
    }

    return [new SystemMessage(systemContent), ...trimmed];
  };
}

const _agents = new Map();

/**
 * Get or create a job-planning agent for a given chat and persona.
 * Caches per chat to maintain tool bindings (like user ID).
 * @param {string} chatId - Chat thread ID
 * @param {string} userId - Authenticated user ID (for repo creation)
 * @param {string} [personaId='default']
 */
export async function getAgent(chatId, userId, personaId = 'default') {
  if (_agents.has(chatId)) {
    return _agents.get(chatId);
  }

  const model = await createModel();
  const soulContent = loadPersonaContent(personaId);
  const delegateTool = createDelegateToPersonaTool();
  const tools = [createJobTool, getJobStatusTool, getSystemTechnicalSpecsTool, getSkillBuildingGuideTool, getSkillDetailsTool, delegateTool];

  if (userId) {
    tools.push(createCreateRepositoryTool({ userId }));
  }

  const webSearchTool = await createWebSearchTool();
  if (webSearchTool) {
    tools.push(webSearchTool);
    console.log(`[agent] Web search enabled (provider: ${getProvider()})`);
  }

  if (isRagEnabled()) {
    tools.push(searchChatHistoryTool);
    console.log('[agent] Chat history search enabled (RAG)');
  }

  const checkpointer = SqliteSaver.fromConnString(thepopebotDb);

  const agent = createReactAgent({
    llm: model,
    tools,
    checkpointSaver: checkpointer,
    prompt: makePrompt(jobPlanningMd, { soul: soulContent }),
  });

  _agents.set(chatId, agent);
  return agent;
}

/**
 * Reset all agent singletons (e.g., when config changes).
 */
export function resetAgent() {
  _agents.clear();
}

const _codeAgents = new Map();

/**
 * Get or create a code agent for a specific chat/workspace.
 * Each code chat gets its own agent with unique start_coding tool bindings.
 * @param {object} context
 * @param {string} context.repo - GitHub repo
 * @param {string} context.branch - Git branch
 * @param {string} context.workspaceId - Pre-created workspace row ID
 * @param {string} context.chatId - Chat thread ID
 * @returns {Promise<object>} LangGraph agent
 */
export async function getCodeAgent({ repo, branch, workspaceId, chatId }) {
  if (_codeAgents.has(chatId)) {
    return _codeAgents.get(chatId);
  }

  const model = await createModel();
  const startHeadlessCodingTool = createStartHeadlessCodingTool({ repo, branch, workspaceId });
  const getRepoDetailsTool = createGetRepositoryDetailsTool({ repo, branch });

  // Look up feature branch for get_branch_file tool
  const { getCodeWorkspaceById } = await import('../db/code-workspaces.js');
  const workspace = getCodeWorkspaceById(workspaceId);
  const featureBranch = workspace?.featureBranch || branch;
  const getBranchFileTool = createGetBranchFileTool({ repo, branch: featureBranch });

  const tools = [startHeadlessCodingTool, getRepoDetailsTool, getBranchFileTool];

  const webSearchTool = await createWebSearchTool();
  if (webSearchTool) {
    tools.push(webSearchTool);
    console.log(`[agent] Web search enabled for code agent (provider: ${getProvider()})`);
  }

  const checkpointer = SqliteSaver.fromConnString(thepopebotDb);

  const agent = createReactAgent({
    llm: model,
    tools,
    checkpointSaver: checkpointer,
    prompt: makePrompt(codePlanningMd),
  });

  _codeAgents.set(chatId, agent);
  return agent;
}
