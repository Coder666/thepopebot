import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { SystemMessage } from '@langchain/core/messages';
import { createModel } from './model.js';
/**
 * Get or create a job-planning agent for a given persona.
 */
export async function getAgent(personaId = 'default') {
  if (_agents.has(personaId)) {
    return _agents.get(personaId);
  }

  const model = await createModel();
  const soulContent = loadPersonaContent(personaId);
  const delegateTool = createDelegateToPersonaTool();
  const tools = [createJobTool, getJobStatusTool, getSystemTechnicalSpecsTool, getSkillBuildingGuideTool, getSkillDetailsTool, delegateTool];
  const checkpointer = SqliteSaver.fromConnString(thepopebotDb);

  const agent = createReactAgent({
    llm: model,
    tools,
    checkpointSaver: checkpointer,
    prompt: (state) => [
      new SystemMessage(render_md(jobPlanningMd, [], { soul: soulContent })),
      ...state.messages,
    ],
  });

  _agents.set(personaId, agent);
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
    prompt: (state) => [new SystemMessage(render_md(codePlanningMd)), ...state.messages],
  });

  _codeAgents.set(chatId, agent);
  return agent;
}
