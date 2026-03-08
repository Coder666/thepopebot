import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { clusterDataDir } from '../paths.js';
import { stopContainer as dockerStopContainer, removeContainer, runClusterWorkerContainer, resolveHostPath, listContainers } from '../tools/docker.js';
import { getRoleWithCluster, getClusterRolesByCluster, roleShortId } from '../db/clusters.js';

/**
 * Compute naming for a cluster's Docker resources.
 * @param {object} cluster
 * @returns {{ project: string, dataDir: string }}
 */
export function clusterNaming(cluster) {
  const shortId = cluster.id.replace(/-/g, '').slice(0, 8);
  const project = `cluster-${shortId}`;
  return { project, dataDir: path.join(clusterDataDir, project) };
}

/**
 * Get the data directory path for a cluster.
 */
export function clusterDir(cluster) {
  const shortId = cluster.id.replace(/-/g, '').slice(0, 8);
  return path.join(clusterDataDir, `cluster-${shortId}`);
}

/**
 * Get the data directory path for a role within a cluster.
 */
export function roleDir(cluster, role) {
  return path.join(clusterDir(cluster), 'role-' + roleShortId(role));
}

/**
 * Container name prefix for a role (used for listing/matching).
 */
function roleContainerPrefix(cluster, role) {
  const cid = cluster.id.replace(/-/g, '').slice(0, 8);
  const rid = role.id.replace(/-/g, '').slice(0, 8);
  return `cluster-${cid}-role-${rid}-`;
}

/**
 * Count running containers for a role.
 */
export async function countRunningForRole(cluster, role) {
  const prefix = roleContainerPrefix(cluster, role);
  const containers = await listContainers(prefix);
  return containers.filter((c) => c.state === 'running').length;
}

/**
 * Resolve {{PLACEHOLDER}} template variables in text.
 * Case-insensitive. Only matches known variable names. Unknown {{...}} passes through.
 */
function resolveClusterVariables(text, vars) {
  if (!text) return text;
  const keys = Object.keys(vars).join('|');
  const pattern = new RegExp(`\\{\\{(${keys})\\}\\}`, 'gi');
  return text.replace(pattern, (_, key) => {
    const match = Object.keys(vars).find(k => k.toLowerCase() === key.toLowerCase());
    return match ? vars[match] : `{{${key}}}`;
  });
}

/**
 * Compute template variables for a cluster worker.
 * Returns a vars object for use with resolveClusterVariables().
 */
function buildTemplateVars(cluster, role, workerUuid, payload) {
  const CLUSTER_HOME = '/home/claude-code/workspace';
  const rShortId = roleShortId(role);
  const SELF_WORK_DIR = `${CLUSTER_HOME}/role-${rShortId}/worker-${workerUuid}/`;
  const SELF_TMP_DIR = `${SELF_WORK_DIR}tmp/`;
  const CLUSTER_SHARED_DIR = `${CLUSTER_HOME}/shared/`;
  const clusterFolderNames = cluster.folders ? JSON.parse(cluster.folders) : [];
  const clusterFolders = clusterFolderNames.map(f => `${CLUSTER_SHARED_DIR}${f}/`);

  const manifest = {
    CLUSTER: {
      CLUSTER_HOME,
      CLUSTER_SHARED_DIR,
      CLUSTER_SHARED_FOLDERS: clusterFolders,
    },
    SELF: {
      SELF_ROLE_NAME: role.roleName || '',
      SELF_WORKER_ID: workerUuid,
      SELF_WORK_DIR,
      SELF_TMP_DIR,
    },
  };

  return {
    CLUSTER_HOME,
    CLUSTER_SHARED_DIR,
    CLUSTER_SHARED_FOLDERS: JSON.stringify(clusterFolders),
    SELF_ROLE_NAME: role.roleName || '',
    SELF_WORKER_ID: workerUuid,
    SELF_WORK_DIR,
    SELF_TMP_DIR,
    DATETIME: new Date().toISOString(),
    WORKSPACE: JSON.stringify(manifest, null, 2),
    PAYLOAD: payload && Object.keys(payload).length > 0 ? JSON.stringify(payload, null, 2) : '',
  };
}

/**
 * Build the system prompt for a role container.
 * Composes: cluster system prompt + role instructions.
 * All {{PLACEHOLDER}} variables are resolved at build time.
 */
function buildWorkerSystemPrompt(cluster, role, vars) {
  const sections = [];

  // Section A: Cluster system prompt (with variables resolved)
  if (cluster.systemPrompt) {
    sections.push(resolveClusterVariables(cluster.systemPrompt.trim(), vars));
  }

  // Section B: Role instructions (with variables resolved)
  if (role.role) {
    sections.push(`## Your Role: ${role.roleName}\n\n${resolveClusterVariables(role.role.trim(), vars)}`);
  }

  return sections.join('\n\n');
}

/**
 * Shared gate: check whether a role is allowed to run.
 * @param {string|object} roleIdOrData - Role UUID or roleData object (from getRoleWithCluster)
 * @returns {Promise<{ allowed: boolean, reason?: string, roleData?: object }>}
 */
export async function canRunRole(roleIdOrData) {
  const roleData = typeof roleIdOrData === 'string'
    ? getRoleWithCluster(roleIdOrData)
    : roleIdOrData;

  if (!roleData || !roleData.cluster) {
    return { allowed: false, reason: 'not_found' };
  }

  if (!roleData.cluster.enabled) {
    return { allowed: false, reason: 'disabled' };
  }

  const runningCount = await countRunningForRole(roleData.cluster, roleData);
  if (runningCount >= roleData.maxConcurrency) {
    console.log(`[cluster] Role ${roleData.roleName} at max concurrency (${runningCount}/${roleData.maxConcurrency}), rejecting`);
    return { allowed: false, reason: 'concurrency' };
  }

  return { allowed: true, roleData };
}

/**
 * Launch a cluster role container.
 * Caller must run canRunRole() first — this function does NOT check disabled/concurrency.
 * @param {object} roleData - Role+cluster object from getRoleWithCluster() or canRunRole()
 * @param {object} [payload] - Optional payload (e.g. webhook body)
 * @returns {Promise<{ containerName?: string, error?: string }>}
 */
export async function runClusterRole(roleData, payload, trigger) {
  const { cluster } = roleData;
  const prefix = roleContainerPrefix(cluster, roleData);

  // Generate dynamic worker ID
  const workerUuid = randomUUID().replace(/-/g, '').slice(0, 8);
  const containerName = `${prefix}${workerUuid}`;
  const dataDir = clusterDir(cluster);

  // Ensure role dirs exist
  const rDir = roleDir(cluster, roleData);
  fs.mkdirSync(path.join(rDir, 'shared'), { recursive: true });
  const workerWorkDir = path.join(rDir, `worker-${workerUuid}`);
  fs.mkdirSync(workerWorkDir, { recursive: true });
  fs.mkdirSync(path.join(workerWorkDir, 'tmp'), { recursive: true });

  const vars = buildTemplateVars(cluster, roleData, workerUuid, payload);
  const systemPrompt = buildWorkerSystemPrompt(cluster, roleData, vars);
  const prompt = resolveClusterVariables(roleData.prompt || 'Execute your role.', vars);

  const env = [];
  if (systemPrompt) {
    env.push(`SYSTEM_PROMPT=${systemPrompt}`);
  }
  if (prompt) {
    env.push(`PROMPT=${prompt}`);
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.push(`CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
  }
  if (process.env.GH_TOKEN) {
    env.push(`GH_TOKEN=${process.env.GH_TOKEN}`);
  }
  env.push(`ROLE_SHORT_ID=${roleShortId(roleData)}`);
  env.push(`ROLE_NAME=${roleData.roleName || 'Role'}`);
  env.push(`WORKER_UUID=${workerUuid}`);
  if (trigger) {
    const triggerLog = JSON.stringify({ ...trigger, ...(payload ? { payload } : {}) }, null, 2);
    env.push(`TRIGGER_LOG=${triggerLog}`);
  }

  const hostDataDir = await resolveHostPath(dataDir);
  const binds = [`${hostDataDir}:/home/claude-code/workspace`];

  console.log(`[cluster] Launching role ${roleData.roleName} (${containerName})${payload ? ` payload=${JSON.stringify(payload)}` : ''}`);

  try {
    const containerWorkDir = workerWorkDir.replace(dataDir, '/home/claude-code/workspace');
    await runClusterWorkerContainer({ containerName, env, binds, workingDir: containerWorkDir });
  } catch (err) {
    console.error(`[cluster] Failed to launch ${containerName}:`, err.message);
    return { containerName, error: err.message };
  }

  // If cleanupWorkerDir is enabled, schedule cleanup after container exits
  if (roleData.cleanupWorkerDir) {
    scheduleWorkerDirCleanup(containerName, workerWorkDir);
  }

  return { containerName };
}

/**
 * Schedule cleanup of a worker directory after its container exits.
 */
function scheduleWorkerDirCleanup(containerName, dirPath) {
  // Poll for container disappearance (AutoRemove handles container removal)
  const interval = setInterval(async () => {
    const containers = await listContainers(containerName);
    const still = containers.find((c) => c.name === containerName);
    if (!still) {
      clearInterval(interval);
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        console.log(`[cluster] Cleaned up worker dir: ${dirPath}`);
      } catch (err) {
        console.error(`[cluster] Failed to clean up ${dirPath}:`, err.message);
      }
    }
  }, 5000);
}

/**
 * Stop all containers for a role.
 */
export async function stopRoleContainers(cluster, role) {
  const prefix = roleContainerPrefix(cluster, role);
  const containers = await listContainers(prefix);
  for (const c of containers) {
    if (c.state === 'running') {
      try {
        await dockerStopContainer(c.name);
      } catch (err) {
        console.error(`[cluster] Failed to stop ${c.name}:`, err.message);
      }
    }
    // Clean up stopped containers (AutoRemove may not fire on force stop)
    try {
      await removeContainer(c.name);
    } catch {}
  }
}
