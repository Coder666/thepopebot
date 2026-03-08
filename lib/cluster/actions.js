'use server';

import fs from 'fs';
import path from 'path';
import { auth } from '../auth/index.js';
import { configDir } from '../paths.js';
import {
  createCluster as dbCreateCluster,
  getClusterById,
  getClustersByUser,
  updateClusterName as dbUpdateClusterName,
  updateClusterSystemPrompt as dbUpdateClusterSystemPrompt,
  updateClusterFolders as dbUpdateClusterFolders,
  toggleClusterStarred as dbToggleClusterStarred,
  toggleClusterEnabled as dbToggleClusterEnabled,
  deleteCluster as dbDeleteCluster,
  createClusterRole as dbCreateClusterRole,
  getClusterRoleById,
  getClusterRolesByCluster,
  updateClusterRole as dbUpdateClusterRole,
  deleteClusterRole as dbDeleteClusterRole,
  reorderClusterRoles as dbReorderClusterRoles,
  getRoleWithCluster,
  roleShortId,
} from '../db/clusters.js';

function readDefault(filename) {
  try { return fs.readFileSync(path.join(configDir, filename), 'utf8'); }
  catch { return ''; }
}

async function requireAuth() {
  const session = await auth();
  if (!session?.user?.id) {
    throw new Error('Unauthorized');
  }
  return session.user;
}

// ── Clusters ──────────────────────────────────────────────

export async function getClusters() {
  const user = await requireAuth();
  return getClustersByUser(user.id);
}

export async function getCluster(clusterId) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return null;
  const roles = getClusterRolesByCluster(clusterId).map((r) => ({
    ...r,
    triggerConfig: r.triggerConfig ? JSON.parse(r.triggerConfig) : null,
    folders: r.folders ? JSON.parse(r.folders) : null,
  }));
  return {
    ...cluster,
    folders: cluster.folders ? JSON.parse(cluster.folders) : null,
    roles,
  };
}

export async function createCluster(name = 'New Cluster') {
  const user = await requireAuth();
  const cluster = dbCreateCluster(user.id, { name, systemPrompt: readDefault('CLUSTER_SYSTEM_PROMPT.md') });
  const { clusterDir } = await import('./execute.js');
  const dir = clusterDir(cluster);
  fs.mkdirSync(`${dir}/shared`, { recursive: true });
  return cluster;
}

export async function renameCluster(clusterId, name) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return { success: false };
  dbUpdateClusterName(clusterId, name);
  return { success: true };
}

export async function starCluster(clusterId) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return { success: false };
  const starred = dbToggleClusterStarred(clusterId);
  return { success: true, starred };
}

export async function updateClusterSystemPrompt(clusterId, systemPrompt) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return { success: false };
  dbUpdateClusterSystemPrompt(clusterId, systemPrompt);
  return { success: true };
}

export async function updateClusterFolders(clusterId, folders) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return { success: false };
  dbUpdateClusterFolders(clusterId, folders);
  if (folders && folders.length) {
    const { clusterDir } = await import('./execute.js');
    const dir = clusterDir(cluster);
    for (const folder of folders) {
      fs.mkdirSync(`${dir}/shared/${folder}`, { recursive: true });
    }
  }
  return { success: true };
}

export async function deleteCluster(clusterId) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return { success: false };
  // Stop all role containers before deleting
  const roles = getClusterRolesByCluster(clusterId);
  const { stopRoleContainers } = await import('./execute.js');
  for (const role of roles) {
    try {
      await stopRoleContainers(cluster, role);
    } catch {}
  }
  dbDeleteCluster(clusterId);
  return { success: true };
}

// ── Cluster Roles (cluster-scoped) ───────────────────────

export async function createClusterRoleAction(clusterId, roleName, role = '') {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return { success: false };
  const record = dbCreateClusterRole(clusterId, { roleName, role: role || readDefault('CLUSTER_ROLE_PROMPT.md') });
  // Create role directory
  const { roleDir } = await import('./execute.js');
  const dir = roleDir(cluster, record);
  fs.mkdirSync(`${dir}/shared`, { recursive: true });
  return { success: true, role: record };
}

export async function updateClusterRoleAction(roleId, updates) {
  const user = await requireAuth();
  const existing = getRoleWithCluster(roleId);
  if (!existing || !existing.cluster || existing.cluster.userId !== user.id) return { success: false };
  dbUpdateClusterRole(roleId, updates);
  // Create folders on disk if provided
  if (updates.folders && updates.folders.length) {
    const { roleDir } = await import('./execute.js');
    const dir = roleDir(existing.cluster, existing);
    for (const folder of updates.folders) {
      fs.mkdirSync(`${dir}/${folder}`, { recursive: true });
    }
  }
  // Reload runtime if triggers changed
  if (updates.triggerConfig !== undefined) {
    const { reloadClusterRuntime } = await import('./runtime.js');
    reloadClusterRuntime();
  }
  return { success: true };
}

export async function deleteClusterRoleAction(roleId) {
  const user = await requireAuth();
  const existing = getRoleWithCluster(roleId);
  if (!existing || !existing.cluster || existing.cluster.userId !== user.id) return { success: false };
  // Stop running containers for this role
  const { stopRoleContainers } = await import('./execute.js');
  await stopRoleContainers(existing.cluster, existing);
  dbDeleteClusterRole(roleId);
  const { reloadClusterRuntime } = await import('./runtime.js');
  reloadClusterRuntime();
  return { success: true };
}

export async function reorderClusterRolesAction(clusterId, orderedRoleIds) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return { success: false };
  dbReorderClusterRoles(clusterId, orderedRoleIds);
  return { success: true };
}

export async function triggerRoleManually(roleId) {
  const user = await requireAuth();
  const roleData = getRoleWithCluster(roleId);
  if (!roleData || !roleData.cluster || roleData.cluster.userId !== user.id) {
    return { error: 'Not found' };
  }
  const { canRunRole, runClusterRole } = await import('./execute.js');
  const check = await canRunRole(roleData);
  if (!check.allowed) {
    if (check.reason === 'disabled') return { error: 'Cluster is disabled' };
    if (check.reason === 'concurrency') return { error: 'Max concurrency reached' };
    return { error: check.reason };
  }
  const result = await runClusterRole(check.roleData, null, { type: 'manual' });
  if (result.error) return { error: result.error };
  return { ok: true, containerName: result.containerName };
}

export async function stopRoleAction(roleId) {
  const user = await requireAuth();
  const roleData = getRoleWithCluster(roleId);
  if (!roleData || !roleData.cluster || roleData.cluster.userId !== user.id) {
    return { success: false };
  }
  const { stopRoleContainers } = await import('./execute.js');
  await stopRoleContainers(roleData.cluster, roleData);
  return { success: true };
}

// ── Start / Stop / Status ─────────────────────────────────

export async function toggleCluster(clusterId) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return { success: false };

  const enabled = dbToggleClusterEnabled(clusterId);

  if (!enabled) {
    // Turning off — stop all running role containers
    const roles = getClusterRolesByCluster(clusterId);
    const { stopRoleContainers } = await import('./execute.js');
    for (const role of roles) {
      try {
        await stopRoleContainers(cluster, role);
      } catch (err) {
        console.error(`[cluster] Failed to stop role ${role.id}:`, err.message);
      }
    }
  }

  const { reloadClusterRuntime } = await import('./runtime.js');
  reloadClusterRuntime();

  return { success: true, enabled };
}

export async function getClusterStatus(clusterId) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return {};

  const roles = getClusterRolesByCluster(clusterId);
  const { countRunningForRole } = await import('./execute.js');

  const status = {};
  for (const role of roles) {
    const running = await countRunningForRole(cluster, role);
    status[role.id] = { running, max: role.maxConcurrency };
  }
  return status;
}

// ── Session Logs ──────────────────────────────────────────

export async function getClusterLogs(clusterId) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return [];

  const { clusterDir } = await import('./execute.js');
  const logsDir = path.join(clusterDir(cluster), 'logs');
  if (!fs.existsSync(logsDir)) return [];

  const entries = [];
  let roleDirs;
  try {
    roleDirs = fs.readdirSync(logsDir).filter((d) => d.startsWith('role-'));
  } catch {
    return [];
  }

  for (const roleDir of roleDirs) {
    const rShortId = roleDir.replace('role-', '');
    const rolePath = path.join(logsDir, roleDir);
    let sessionDirs;
    try {
      sessionDirs = fs.readdirSync(rolePath).sort().reverse();
    } catch {
      continue;
    }

    const sessions = [];
    let roleName = rShortId;
    for (const sessionName of sessionDirs) {
      const metaPath = path.join(rolePath, sessionName, 'meta.json');
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {}
      if (meta.roleName) roleName = meta.roleName;
      sessions.push({
        name: sessionName,
        startedAt: meta.startedAt || null,
        endedAt: meta.endedAt || null,
      });
    }

    entries.push({ roleShortId: rShortId, roleName, sessions });
  }

  return entries;
}

export async function getSessionLog(clusterId, roleShortId, sessionName, file) {
  const user = await requireAuth();
  const cluster = getClusterById(clusterId);
  if (!cluster || cluster.userId !== user.id) return null;

  const allowed = { stdout: 'stdout.jsonl', stderr: 'stderr.txt', prompt: 'prompt.md', trigger: 'trigger.json' };
  const filename = allowed[file];
  if (!filename) return null;

  const { clusterDir } = await import('./execute.js');
  const filePath = path.join(clusterDir(cluster), 'logs', `role-${roleShortId}`, sessionName, filename);

  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
