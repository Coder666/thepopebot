import http from 'http';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getGhToken } = require('../gh-wrapper/lib/config.js');

/**
 * Make a request to the Docker Engine API via Unix socket.
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {object} [body] - Request body
 * @returns {Promise<object>} Parsed JSON response
 */
function dockerApi(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      socketPath: '/var/run/docker.sock',
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode, data: { message: data } });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Make a raw streaming request to the Docker Engine API via Unix socket.
 * Returns the raw http.IncomingMessage (readable stream).
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @returns {Promise<http.IncomingMessage>}
 */
function dockerApiStream(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: '/var/run/docker.sock',
      path,
      method,
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

/**
 * Derive the shared volume name from a workspace ID.
 * @param {string} workspaceId
 * @returns {string}
 */
function volumeName(workspaceId) {
  const shortId = workspaceId.replace(/-/g, '').slice(0, 8);
  return `code-workspace-${shortId}`;
}

/**
 * Auto-detect the Docker network by inspecting the event-handler container.
 * @returns {Promise<string>} Network name
 */
async function detectNetwork() {
  try {
    const { status, data } = await dockerApi('GET', '/containers/thepopebot-event-handler/json');
    if (status === 200 && data.NetworkSettings?.Networks) {
      const networks = Object.keys(data.NetworkSettings.Networks);
      if (networks.length > 0) return networks[0];
    }
  } catch {}
  return 'bridge';
}

/**
 * Generic container creation and start.
 * @param {object} options
 * @param {string} options.containerName - Docker container name
 * @param {string} options.image - Docker image reference
 * @param {string[]} [options.env] - Environment variables
 * @param {object} [options.hostConfig] - Docker HostConfig overrides
 * @returns {Promise<{containerId: string, containerName: string}>}
 */
async function runContainer({ containerName, image, env = [], workingDir, hostConfig = {} }) {
  const network = await detectNetwork();
  if (!hostConfig.NetworkMode) {
    hostConfig.NetworkMode = network;
  }

  // Pull image if not present locally
  const inspectRes = await dockerApi('GET', `/images/${encodeURIComponent(image)}/json`);
  if (inspectRes.status !== 200) {
    const [fromImage, tag] = image.includes(':') ? image.split(':') : [image, 'latest'];
    const pullRes = await dockerApi('POST', `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`);
    if (pullRes.status !== 200) {
      throw new Error(`Docker pull failed (${pullRes.status}): ${pullRes.data?.message || JSON.stringify(pullRes.data)}`);
    }
  }

  // Create container
  const createRes = await dockerApi('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, {
    Image: image,
    Env: env,
    ...(workingDir ? { WorkingDir: workingDir } : {}),
    HostConfig: hostConfig,
  });

  if (createRes.status !== 201) {
    throw new Error(`Docker create failed (${createRes.status}): ${createRes.data?.message || JSON.stringify(createRes.data)}`);
  }

  const containerId = createRes.data.Id;

  // Start container
  const startRes = await dockerApi('POST', `/containers/${containerId}/start`);
  if (startRes.status !== 204 && startRes.status !== 304) {
    throw new Error(`Docker start failed (${startRes.status}): ${startRes.data?.message || JSON.stringify(startRes.data)}`);
  }

  return { containerId, containerName };
}

/**
 * Create and start a code workspace Docker container.
 * @param {object} options
 * @param {string} options.containerName - Docker container name
 * @param {string} options.repo - GitHub repo full name (e.g. "owner/repo")
 * @param {string} options.branch - Git branch name
 * @param {string} [options.codingAgent='claude-code'] - Coding agent identifier
 * @param {string} [options.featureBranch] - Feature branch to create after cloning
 * @returns {Promise<{containerId: string, containerName: string}>}
 */
async function runCodeWorkspaceContainer({ containerName, repo, branch, codingAgent = 'claude-code', featureBranch, workspaceId, chatContext }) {
  if (codingAgent !== 'claude-code') {
    throw new Error(`Unsupported coding agent: ${codingAgent}`);
  }

  const version = process.env.THEPOPEBOT_VERSION;
  const image = `stephengpope/thepopebot:claude-code-workspace-${version}`;

  const env = [
    `REPO=${repo}`,
    `BRANCH=${branch}`,
  ];
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.push(`CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
  }
  const ghToken = getGhToken();
  if (ghToken) {
    env.push(`GH_TOKEN=${ghToken}`);
  }
  if (featureBranch) {
    env.push(`FEATURE_BRANCH=${featureBranch}`);
  }
  if (chatContext) {
    env.push(`CHAT_CONTEXT=${chatContext}`);
  }

  const hostConfig = {};
  if (workspaceId) {
    hostConfig.Binds = [`${volumeName(workspaceId)}:/home/claude-code/workspace`];
  }

  return runContainer({ containerName, image, env, hostConfig });
}

/**
 * Inspect a Docker container by name.
 * @param {string} containerName
 * @returns {Promise<object|null>} Container info or null if not found
 */
async function inspectContainer(containerName) {
  const { status, data } = await dockerApi('GET', `/containers/${encodeURIComponent(containerName)}/json`);
  if (status === 404) return null;
  if (status === 200) return data;
  throw new Error(`Docker inspect failed (${status}): ${data?.message || JSON.stringify(data)}`);
}

/**
 * Start a stopped Docker container.
 * @param {string} containerName
 */
async function startContainer(containerName) {
  const { status, data } = await dockerApi('POST', `/containers/${encodeURIComponent(containerName)}/start`);
  if (status === 204 || status === 304) return;
  throw new Error(`Docker start failed (${status}): ${data?.message || JSON.stringify(data)}`);
}

/**
 * Force-remove a Docker container.
 * @param {string} containerName
 */
async function removeContainer(containerName) {
  const { status, data } = await dockerApi('DELETE', `/containers/${encodeURIComponent(containerName)}?force=true`);
  if (status === 204 || status === 404) return;
  throw new Error(`Docker remove failed (${status}): ${data?.message || JSON.stringify(data)}`);
}

/**
 * Create and start a headless Claude Code container.
 * Runs a task via `claude -p`, commits, and merges back. Ephemeral — exits when done.
 * @param {object} options
 * @param {string} options.containerName - Docker container name
 * @param {string} options.repo - GitHub repo full name
 * @param {string} options.branch - Base branch
 * @param {string} options.featureBranch - Feature branch name
 * @param {string} options.workspaceId - Workspace ID (for volume name)
 * @param {string} options.taskPrompt - Task description for Claude Code
 * @returns {Promise<{containerId: string, containerName: string}>}
 */
async function runHeadlessCodeContainer({ containerName, repo, branch, featureBranch, workspaceId, taskPrompt }) {
  const version = process.env.THEPOPEBOT_VERSION;
  const image = `stephengpope/thepopebot:claude-code-headless-${version}`;

  const env = [
    `REPO=${repo}`,
    `BRANCH=${branch}`,
    `FEATURE_BRANCH=${featureBranch}`,
    `HEADLESS_TASK=${taskPrompt}`,
  ];
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.push(`CLAUDE_CODE_OAUTH_TOKEN=${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
  }
  const ghToken2 = getGhToken();
  if (ghToken2) {
    env.push(`GH_TOKEN=${ghToken2}`);
  }

  return runContainer({
    containerName,
    image,
    env,
    hostConfig: {
      Binds: [`${volumeName(workspaceId)}:/home/claude-code/workspace`],
    },
  });
}

/**
 * Create and start a cluster worker container.
 * @param {object} options
 * @param {string} options.containerName - Stable container name
 * @param {string} [options.image] - Docker image (defaults to cluster-worker image)
 * @param {string[]} [options.env] - Environment variables
 * @param {string[]} [options.binds] - Bind mount strings
 * @returns {Promise<{containerId: string, containerName: string}>}
 */
async function runClusterWorkerContainer({ containerName, image, env = [], binds = [], workingDir }) {
  const version = process.env.THEPOPEBOT_VERSION;
  const resolvedImage = image || `stephengpope/thepopebot:claude-code-cluster-worker-${version}`;

  return runContainer({
    containerName,
    image: resolvedImage,
    env,
    workingDir,
    hostConfig: {
      AutoRemove: true,
      ...(binds.length > 0 ? { Binds: binds } : {}),
    },
  });
}

/**
 * Execute a command inside a running container and return stdout.
 * Uses Docker Engine API exec endpoints via Unix socket.
 * @param {string} containerName
 * @param {string} cmd - Shell command to run
 * @param {number} [timeoutMs=5000] - Timeout in milliseconds
 * @returns {Promise<string|null>} stdout or null on failure
 */
async function execInContainer(containerName, cmd, timeoutMs = 5000) {
  try {
    // Create exec instance
    const createRes = await dockerApi('POST',
      `/containers/${encodeURIComponent(containerName)}/exec`,
      { Cmd: ['sh', '-c', cmd], AttachStdout: true, AttachStderr: false }
    );
    if (createRes.status !== 201 || !createRes.data?.Id) {
      console.error(`[execInContainer] exec create failed (${createRes.status}): container=${containerName}`, createRes.data?.message || '');
      return null;
    }

    const execId = createRes.data.Id;

    // Start exec and capture raw output as Buffer (not string — avoids binary corruption)
    const buf = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      const req = http.request({
        socketPath: '/var/run/docker.sock',
        path: `/exec/${execId}/start`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
      });
      req.on('error', (err) => { clearTimeout(timer); reject(err); });
      req.write(JSON.stringify({ Detach: false, Tty: false }));
      req.end();
    });

    // Docker multiplexed stream: strip 8-byte header frames
    // Each frame: [type(1) + padding(3) + size(4)] + payload
    let stdout = '';
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      if (offset + 8 + size > buf.length) break;
      if (buf[offset] === 1) { // stdout stream
        stdout += buf.slice(offset + 8, offset + 8 + size).toString('utf8');
      }
      offset += 8 + size;
    }

    return stdout;
  } catch (err) {
    console.error(`[execInContainer] container=${containerName} cmd=${cmd}`, err.message || err);
    return null;
  }
}

/**
 * Tail container logs as a readable stream.
 * @param {string} containerName
 * @returns {Promise<http.IncomingMessage>} Raw readable stream of stdout+stderr
 */
async function tailContainerLogs(containerName) {
  const res = await dockerApiStream('GET',
    `/containers/${encodeURIComponent(containerName)}/logs?stdout=true&stderr=true&follow=true&tail=all`
  );
  return res;
}

/**
 * Wait for a container to exit and return its exit code.
 * @param {string} containerName
 * @returns {Promise<number>} Exit code
 */
async function waitForContainer(containerName) {
  const { status, data } = await dockerApi('POST', `/containers/${encodeURIComponent(containerName)}/wait`);
  if (status === 200) return data.StatusCode;
  throw new Error(`Docker wait failed (${status}): ${data?.message || JSON.stringify(data)}`);
}

/**
 * Remove the shared named volume for a workspace.
 * @param {string} workspaceId
 */
async function removeCodeWorkspaceVolume(workspaceId) {
  const vol = volumeName(workspaceId);
  const { status, data } = await dockerApi('DELETE', `/volumes/${encodeURIComponent(vol)}`);
  if (status === 204 || status === 404) return;
  throw new Error(`Docker volume remove failed (${status}): ${data?.message || JSON.stringify(data)}`);
}

/**
 * Stop a running Docker container.
 * @param {string} containerName
 */
async function stopContainer(containerName) {
  const { status, data } = await dockerApi('POST', `/containers/${encodeURIComponent(containerName)}/stop`);
  if (status === 204 || status === 304 || status === 404) return;
  throw new Error(`Docker stop failed (${status}): ${data?.message || JSON.stringify(data)}`);
}

/**
 * Resolve a container-internal path to the corresponding host path for bind mounts.
 * Inside the event-handler container, paths start with /app but Docker bind mounts
 * need the actual host path. Inspects our own container's mounts to find the mapping.
 * @param {string} containerPath
 * @returns {Promise<string>} Host path, or original if not running in Docker
 */
let _hostProjectPath = undefined;
async function resolveHostPath(containerPath) {
  if (_hostProjectPath === undefined) {
    _hostProjectPath = null;
    try {
      const { status, data } = await dockerApi('GET', '/containers/thepopebot-event-handler/json');
      if (status === 200 && data.Mounts) {
        const appMount = data.Mounts.find((m) => m.Destination === '/app' && m.Type === 'bind');
        if (appMount) _hostProjectPath = appMount.Source;
      }
    } catch {}
  }
  if (_hostProjectPath && containerPath.startsWith('/app/')) {
    return _hostProjectPath + containerPath.slice(4);
  }
  return containerPath;
}

/**
 * Get live stats for a container (CPU, memory, network).
 * @param {string} containerName
 * @returns {Promise<{ cpu: number, memUsage: number, memLimit: number, netRx: number, netTx: number } | null>}
 */
async function getContainerStats(containerName) {
  try {
    const { status, data } = await dockerApi('GET',
      `/containers/${encodeURIComponent(containerName)}/stats?stream=false`
    );
    if (status !== 200 || !data) return null;

    // CPU % from delta
    const cpuDelta = (data.cpu_stats?.cpu_usage?.total_usage || 0) - (data.precpu_stats?.cpu_usage?.total_usage || 0);
    const systemDelta = (data.cpu_stats?.system_cpu_usage || 0) - (data.precpu_stats?.system_cpu_usage || 0);
    const numCpus = data.cpu_stats?.online_cpus || data.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
    const cpu = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    // Memory
    const memUsage = data.memory_stats?.usage || 0;
    const memLimit = data.memory_stats?.limit || 0;

    // Network (sum all interfaces)
    let netRx = 0, netTx = 0;
    if (data.networks) {
      for (const iface of Object.values(data.networks)) {
        netRx += iface.rx_bytes || 0;
        netTx += iface.tx_bytes || 0;
      }
    }

    return { cpu: Math.round(cpu * 100) / 100, memUsage, memLimit, netRx, netTx };
  } catch {
    return null;
  }
}

/**
 * List containers matching a name prefix.
 * @param {string} namePrefix - Container name prefix to filter by
 * @returns {Promise<Array<{ id: string, name: string, state: string }>>}
 */
async function listContainers(namePrefix) {
  const filters = JSON.stringify({ name: [`^/${namePrefix}`] });
  const { status, data } = await dockerApi('GET',
    `/containers/json?all=true&filters=${encodeURIComponent(filters)}`
  );
  if (status !== 200 || !Array.isArray(data)) return [];
  return data.map((c) => ({
    id: c.Id,
    name: (c.Names?.[0] || '').replace(/^\//, ''),
    state: c.State,
  }));
}

export {
  runCodeWorkspaceContainer,
  runHeadlessCodeContainer,
  runClusterWorkerContainer,
  inspectContainer,
  startContainer,
  stopContainer,
  removeContainer,
  execInContainer,
  tailContainerLogs,
  waitForContainer,
  removeCodeWorkspaceVolume,
  resolveHostPath,
  getContainerStats,
  listContainers,
};
