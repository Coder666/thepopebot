import { randomUUID } from 'crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getDb } from './index.js';
import { clusters, clusterRoles } from './schema.js';

export function roleShortId(role) {
  return role.id.replace(/-/g, '').slice(0, 8);
}

// ── Clusters ──────────────────────────────────────────────

export function createCluster(userId, { name = 'New Cluster', systemPrompt = '', id = null } = {}) {
  const db = getDb();
  const now = Date.now();
  const cluster = {
    id: id || randomUUID(),
    userId,
    name,
    systemPrompt,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(clusters).values(cluster).run();
  return cluster;
}

export function getClusterById(id) {
  const db = getDb();
  return db.select().from(clusters).where(eq(clusters.id, id)).get();
}

export function getClustersByUser(userId) {
  const db = getDb();
  return db
    .select()
    .from(clusters)
    .where(eq(clusters.userId, userId))
    .orderBy(desc(clusters.updatedAt))
    .all();
}

export function updateClusterName(id, name) {
  const db = getDb();
  db.update(clusters)
    .set({ name, updatedAt: Date.now() })
    .where(eq(clusters.id, id))
    .run();
}

export function updateClusterSystemPrompt(id, systemPrompt) {
  const db = getDb();
  db.update(clusters)
    .set({ systemPrompt, updatedAt: Date.now() })
    .where(eq(clusters.id, id))
    .run();
}

export function toggleClusterStarred(id) {
  const db = getDb();
  const cluster = db.select({ starred: clusters.starred }).from(clusters).where(eq(clusters.id, id)).get();
  const newValue = cluster?.starred ? 0 : 1;
  db.update(clusters)
    .set({ starred: newValue })
    .where(eq(clusters.id, id))
    .run();
  return newValue;
}

export function toggleClusterEnabled(id) {
  const db = getDb();
  const cluster = db.select({ enabled: clusters.enabled }).from(clusters).where(eq(clusters.id, id)).get();
  const newValue = cluster?.enabled ? 0 : 1;
  db.update(clusters)
    .set({ enabled: newValue, updatedAt: Date.now() })
    .where(eq(clusters.id, id))
    .run();
  return newValue;
}

export function updateClusterFolders(id, folders) {
  const db = getDb();
  db.update(clusters)
    .set({ folders: folders ? JSON.stringify(folders) : null, updatedAt: Date.now() })
    .where(eq(clusters.id, id))
    .run();
}

export function deleteCluster(id) {
  const db = getDb();
  db.delete(clusterRoles).where(eq(clusterRoles.clusterId, id)).run();
  db.delete(clusters).where(eq(clusters.id, id)).run();
}

// ── Cluster Roles (cluster-scoped) ───────────────────────

export function createClusterRole(clusterId, { roleName, role = '', prompt, id = null } = {}) {
  const db = getDb();
  const now = Date.now();
  const maxRow = db.select({ max: sql`COALESCE(MAX(${clusterRoles.sortOrder}), -1)` })
    .from(clusterRoles)
    .where(eq(clusterRoles.clusterId, clusterId))
    .get();
  const sortOrder = (maxRow?.max ?? -1) + 1;
  const record = {
    id: id || randomUUID(),
    clusterId,
    roleName,
    role,
    ...(prompt !== undefined ? { prompt } : {}),
    sortOrder,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(clusterRoles).values(record).run();
  // Touch parent cluster
  db.update(clusters).set({ updatedAt: now }).where(eq(clusters.id, clusterId)).run();
  return record;
}

export function getClusterRoleById(id) {
  const db = getDb();
  return db.select().from(clusterRoles).where(eq(clusterRoles.id, id)).get();
}

export function getClusterRolesByCluster(clusterId) {
  const db = getDb();
  return db
    .select()
    .from(clusterRoles)
    .where(eq(clusterRoles.clusterId, clusterId))
    .orderBy(clusterRoles.sortOrder, clusterRoles.createdAt)
    .all();
}

export function updateClusterRole(id, updates) {
  const db = getDb();
  const set = { updatedAt: Date.now() };
  if (updates.roleName !== undefined) set.roleName = updates.roleName;
  if (updates.role !== undefined) set.role = updates.role;
  if (updates.prompt !== undefined) set.prompt = updates.prompt;
  if (updates.triggerConfig !== undefined) set.triggerConfig = updates.triggerConfig ? JSON.stringify(updates.triggerConfig) : null;
  if (updates.maxConcurrency !== undefined) set.maxConcurrency = updates.maxConcurrency;
  if (updates.cleanupWorkerDir !== undefined) set.cleanupWorkerDir = updates.cleanupWorkerDir;
  if (updates.folders !== undefined) set.folders = updates.folders ? JSON.stringify(updates.folders) : null;
  db.update(clusterRoles)
    .set(set)
    .where(eq(clusterRoles.id, id))
    .run();
}

export function deleteClusterRole(id) {
  const db = getDb();
  db.delete(clusterRoles).where(eq(clusterRoles.id, id)).run();
}

export function reorderClusterRoles(clusterId, orderedIds) {
  const db = getDb();
  for (let i = 0; i < orderedIds.length; i++) {
    db.update(clusterRoles)
      .set({ sortOrder: i })
      .where(and(eq(clusterRoles.id, orderedIds[i]), eq(clusterRoles.clusterId, clusterId)))
      .run();
  }
}

export function getRoleWithCluster(roleId) {
  const db = getDb();
  const role = db.select().from(clusterRoles).where(eq(clusterRoles.id, roleId)).get();
  if (!role) return null;
  const cluster = db.select().from(clusters).where(eq(clusters.id, role.clusterId)).get();
  return {
    ...role,
    triggerConfig: role.triggerConfig ? JSON.parse(role.triggerConfig) : null,
    folders: role.folders ? JSON.parse(role.folders) : null,
    cluster,
  };
}

export function getAllRolesWithTriggers() {
  const db = getDb();
  return db
    .select({ role: clusterRoles })
    .from(clusterRoles)
    .innerJoin(clusters, eq(clusterRoles.clusterId, clusters.id))
    .where(sql`${clusterRoles.triggerConfig} IS NOT NULL AND ${clusters.enabled} = 1`)
    .all()
    .map(({ role }) => ({
      ...role,
      triggerConfig: JSON.parse(role.triggerConfig),
    }));
}
