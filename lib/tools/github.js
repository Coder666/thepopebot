import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { getGhToken } = require('../gh-wrapper/lib/config.js');

/**
 * GitHub REST API helper with authentication
 * @param {string} endpoint - API endpoint (e.g., '/repos/owner/repo/...')
 * @param {object} options - Fetch options (method, body, headers)
 * @returns {Promise<object>} - Parsed JSON response
 */
async function githubApi(endpoint, options = {}) {
  const GH_TOKEN = getGhToken();
  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${GH_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`GitHub API error: ${res.status} ${error}`);
  }

  return res.json();
}

/**
 * Get workflow runs with optional status and workflow filter
 * @param {string} [status] - Filter by status (in_progress, queued, completed)
 * @param {string} [workflow] - Workflow filename to scope to (e.g., 'run-job.yml')
 * @returns {Promise<object>} - Workflow runs response
 */
async function getWorkflowRuns(status, { workflow, page = 1, perPage = 100 } = {}) {
  const { GH_OWNER, GH_REPO } = process.env;
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('per_page', String(perPage));
  params.set('page', String(page));

  const query = params.toString();
  const path = workflow
    ? `/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${workflow}/runs?${query}`
    : `/repos/${GH_OWNER}/${GH_REPO}/actions/runs?${query}`;
  return githubApi(path);
}

/**
 * Get jobs for a specific workflow run
 * @param {number} runId - Workflow run ID
 * @returns {Promise<object>} - Jobs response with steps
 */
async function getWorkflowRunJobs(runId) {
  const { GH_OWNER, GH_REPO } = process.env;
  return githubApi(`/repos/${GH_OWNER}/${GH_REPO}/actions/runs/${runId}/jobs`);
}

/**
 * Get job status for running/recent jobs
 * @param {string} [jobId] - Optional specific job ID to filter by
 * @returns {Promise<object>} - Status summary with jobs array
 */
async function getJobStatus(jobId) {
  // Fetch both in_progress and queued runs (scoped to run-job.yml)
  const [inProgress, queued] = await Promise.all([
    getWorkflowRuns('in_progress', { workflow: 'run-job.yml' }),
    getWorkflowRuns('queued', { workflow: 'run-job.yml' }),
  ]);

  const allRuns = [...(inProgress.workflow_runs || []), ...(queued.workflow_runs || [])];

  // Filter to only job/* branches
  const jobRuns = allRuns.filter(run => run.head_branch?.startsWith('job/'));

  // If specific job requested, filter further
  const filteredRuns = jobId
    ? jobRuns.filter(run => run.head_branch === `job/${jobId}`)
    : jobRuns;

  // Get detailed job info for each run
  const jobs = await Promise.all(
    filteredRuns.map(async (run) => {
      const extractedJobId = run.head_branch.slice(4); // Remove 'job/' prefix
      const startedAt = new Date(run.created_at);
      const durationMinutes = Math.round((Date.now() - startedAt.getTime()) / 60000);

      let currentStep = null;
      let stepsCompleted = 0;
      let stepsTotal = 0;

      try {
        const jobsData = await getWorkflowRunJobs(run.id);
        if (jobsData.jobs?.length > 0) {
          const job = jobsData.jobs[0];
          stepsTotal = job.steps?.length || 0;
          stepsCompleted = job.steps?.filter(s => s.status === 'completed').length || 0;
          currentStep = job.steps?.find(s => s.status === 'in_progress')?.name || null;
        }
      } catch (err) {
        // Jobs endpoint may fail if run hasn't started yet
      }

      return {
        job_id: extractedJobId,
        branch: run.head_branch,
        status: run.status,
        started_at: run.created_at,
        duration_minutes: durationMinutes,
        current_step: currentStep,
        steps_completed: stepsCompleted,
        steps_total: stepsTotal,
        run_id: run.id,
      };
    })
  );

  // Count only job/* branches, not all workflows
  const runningCount = jobs.filter(j => j.status === 'in_progress').length;
  const queuedCount = jobs.filter(j => j.status === 'queued').length;

  return {
    jobs,
    queued: queuedCount,
    running: runningCount,
  };
}

/**
 * Get full runners status: unified list of all workflow runs with counts
 * @param {number} [page=1] - Page number for pagination
 * @returns {Promise<object>} - { runs, hasMore, counts }
 */
async function getRunnersStatus(page = 1) {
  const data = await getWorkflowRuns(null, { page, perPage: 25 });

  const runs = (data.workflow_runs || []).map(run => ({
    run_id: run.id,
    branch: run.head_branch,
    status: run.status,
    conclusion: run.conclusion,
    workflow_name: run.name,
    started_at: run.created_at,
    updated_at: run.updated_at,
    duration_seconds: Math.round((Date.now() - new Date(run.created_at).getTime()) / 1000),
    html_url: run.html_url,
  }));

  return {
    runs,
    hasMore: page * 25 < (data.total_count || 0),
  };
}

/**
 * Trigger a workflow via workflow_dispatch
 * @param {string} workflowId - Workflow file name (e.g., 'upgrade-event-handler.yml')
 * @param {string} [ref='main'] - Git ref to run the workflow on
 * @param {object} [inputs={}] - Workflow inputs
 */
async function triggerWorkflowDispatch(workflowId, ref = 'main', inputs = {}) {
  const { GH_OWNER, GH_REPO } = process.env;
  const res = await fetch(
    `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/actions/workflows/${workflowId}/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getGhToken()}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref, inputs }),
    }
  );
  if (!res.ok && res.status !== 204) {
    const error = await res.text();
    throw new Error(`GitHub API error: ${res.status} ${error}`);
  }
  return { success: true };
}

/**
 * Fetch the session log (.jsonl) for a job from the GitHub repo at a specific commit.
 * @param {string} jobId - The job ID (used to locate logs/{jobId}/)
 * @param {string} commitSha - Git commit SHA to read from
 * @returns {Promise<string>} - Log content or empty string if unavailable
 */
async function fetchJobLog(jobId, commitSha) {
  if (!commitSha) return '';
  const { GH_OWNER, GH_REPO } = process.env;
  try {
    const files = await githubApi(
      `/repos/${GH_OWNER}/${GH_REPO}/contents/logs/${jobId}?ref=${encodeURIComponent(commitSha)}`
    );
    if (!Array.isArray(files)) return '';
    const logFile = files.find(f => f.name.endsWith('.jsonl'));
    if (!logFile || !logFile.download_url) return '';
    const res = await fetch(logFile.download_url, {
      headers: { 'Authorization': `Bearer ${getGhToken()}` },
    });
    if (!res.ok) return '';
    return await res.text();
  } catch (err) {
    console.error('Failed to fetch job log:', err.message);
    return '';
  }
}

/**
 * Fetch open pull requests for the repository.
 * @returns {Promise<object[]>} - Array of open PRs
 */
async function getOpenPullRequests() {
  const { GH_OWNER, GH_REPO } = process.env;
  const pulls = await githubApi(
    `/repos/${GH_OWNER}/${GH_REPO}/pulls?state=open&sort=created&direction=desc&per_page=100`
  );
  return pulls.map(pr => ({
    id: pr.id,
    number: pr.number,
    title: pr.title,
    html_url: pr.html_url,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    user: pr.user?.login || 'unknown',
    head_branch: pr.head?.ref || '',
    base_branch: pr.base?.ref || '',
  }));
}

/**
 * List repositories accessible to the authenticated user.
 * @returns {Promise<{full_name: string, default_branch: string}[]>}
 */
async function listRepositories() {
  const repos = await githubApi('/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member');

  // GitHub fine-grained PATs grant implicit metadata:read on all affiliated repos,
  // so /user/repos returns repos outside the token's scope. There is no API to query
  // which repos a PAT is scoped to. Workaround: probe write access with an invalid
  // ref creation (null SHA). 422 = has access, 403 = no access. Nothing is created.
  const probes = await Promise.allSettled(repos.map(async (r) => {
    const res = await fetch(`https://api.github.com/repos/${r.full_name}/git/refs`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${getGhToken()}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: 'refs/heads/__access_probe__',
        sha: '0000000000000000000000000000000000000000',
      }),
    });
    return { repo: r, status: res.status };
  }));

  return probes
    .filter(p => p.status === 'fulfilled' && p.value.status !== 403)
    .map(p => ({
      full_name: p.value.repo.full_name,
      default_branch: p.value.repo.default_branch,
    }));
}

/**
 * List branches for a repository.
 * @param {string} repoFullName - e.g. "owner/repo"
 * @returns {Promise<{name: string, isDefault: boolean}[]>}
 */
async function listBranches(repoFullName) {
  const [owner, repo] = repoFullName.split('/');
  const [branches, repoInfo] = await Promise.all([
    githubApi(`/repos/${owner}/${repo}/branches?per_page=100`),
    githubApi(`/repos/${owner}/${repo}`),
  ]);
  const defaultBranch = repoInfo.default_branch;
  return branches.map(b => ({
    name: b.name,
    isDefault: b.name === defaultBranch,
  }));
}

export {
  githubApi,
  getWorkflowRuns,
  getWorkflowRunJobs,
  getJobStatus,
  getRunnersStatus,
  triggerWorkflowDispatch,
  fetchJobLog,
  getOpenPullRequests,
  listRepositories,
  listBranches,
};
