const API_ROOT = "https://api.github.com";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "stc:get-state") {
    getState().then((state) => sendResponse({ ok: true, state }));
    return true;
  }

  if (message?.type === "stc:save-token") {
    saveNamedToken(message.name, message.token)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Save failed" })
      );
    return true;
  }

  if (message?.type === "stc:delete-token") {
    deleteNamedToken(message.id)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : "Delete failed" })
      );
    return true;
  }

  if (message?.type === "stc:set-repo-enabled") {
    chrome.storage.sync.get({ enabledRepos: {} }, ({ enabledRepos }) => {
      const next = { ...enabledRepos, [message.repo]: Boolean(message.enabled) };
      chrome.storage.sync.set({ enabledRepos: next }, () => sendResponse({ ok: true }));
    });
    return true;
  }

  if (message?.type === "stc:load-commits") {
    loadCommits(message)
      .then((payload) => sendResponse({ ok: true, payload }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "Unknown error"
        })
      );
    return true;
  }

  return false;
});

async function loadCommits({ owner, repo, branch, perPage = 30, branchesPerPage = 12 }) {
  const { tokens } = await getState();
  const repoPath = `${owner}/${repo}`;
  const candidates = dedupeCandidates(tokens);
  let lastError = "Unable to load repository.";

  for (const candidate of candidates) {
    const headers = buildHeaders(candidate.token);

    try {
      const repoData = await fetchGitHubJson(`${API_ROOT}/repos/${repoPath}`, headers, candidate.name);
      const targetBranch = branch || repoData.default_branch;
      const branches = await loadBranches({
        repoPath,
        headers,
        targetBranch,
        defaultBranch: repoData.default_branch,
        branchesPerPage,
        tokenName: candidate.name
      });
      const branchHistories = await loadBranchHistories({
        repoPath,
        headers,
        branches,
        perPage,
        tokenName: candidate.name
      });

      if (!branchHistories.length) {
        throw new Error("No commit history was returned for this repository.");
      }

      return buildCommitPayload({
        repo: repoData,
        targetBranch,
        branchHistories
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unable to load repository.";
    }
  }

  throw new Error(lastError);
}

async function loadBranches({ repoPath, headers, targetBranch, defaultBranch, branchesPerPage, tokenName }) {
  const branchesUrl = new URL(`${API_ROOT}/repos/${repoPath}/branches`);
  branchesUrl.searchParams.set("per_page", String(branchesPerPage));

  const listedBranches = await fetchGitHubJson(branchesUrl, headers, tokenName);
  const branchMap = new Map();

  for (const branch of listedBranches || []) {
    if (branch?.name) {
      branchMap.set(branch.name, branch);
    }
  }

  for (const branchName of [targetBranch, defaultBranch]) {
    if (!branchName || branchMap.has(branchName)) {
      continue;
    }
    const branch = await fetchGitHubJson(
      `${API_ROOT}/repos/${repoPath}/branches/${encodeURIComponent(branchName)}`,
      headers,
      tokenName
    );
    if (branch?.name) {
      branchMap.set(branch.name, branch);
    }
  }

  return Array.from(branchMap.values()).sort((left, right) =>
    compareBranchPriority(left.name, right.name, targetBranch, defaultBranch)
  );
}

async function loadBranchHistories({ repoPath, headers, branches, perPage, tokenName }) {
  const branchResults = await Promise.allSettled(
    branches.map(async (branch) => {
      const commitsUrl = new URL(`${API_ROOT}/repos/${repoPath}/commits`);
      commitsUrl.searchParams.set("sha", branch.name);
      commitsUrl.searchParams.set("per_page", String(perPage));
      const commits = await fetchGitHubJson(commitsUrl, headers, tokenName);
      return {
        branch,
        commits: Array.isArray(commits) ? commits : []
      };
    })
  );

  return branchResults
    .filter((result) => result.status === "fulfilled" && result.value.commits.length)
    .map((result) => result.value);
}

function buildCommitPayload({ repo, targetBranch, branchHistories }) {
  const commitMap = new Map();
  const branches = [];

  for (const { branch, commits } of branchHistories) {
    const branchCommitShas = [];

    for (const commit of commits) {
      if (!commit?.sha) {
        continue;
      }

      branchCommitShas.push(commit.sha);

      if (!commitMap.has(commit.sha)) {
        commitMap.set(commit.sha, {
          ...commit,
          branches: [branch.name]
        });
        continue;
      }

      const existing = commitMap.get(commit.sha);
      if (!existing.branches.includes(branch.name)) {
        existing.branches.push(branch.name);
      }
    }

    branches.push({
      name: branch.name,
      headSha: branch.commit?.sha || branchCommitShas[0] || "",
      commits: dedupeShas(branchCommitShas),
      protected: Boolean(branch.protected),
      isCurrent: branch.name === targetBranch,
      isDefault: branch.name === repo.default_branch
    });
  }

  return {
    repo,
    branch: targetBranch,
    commits: Array.from(commitMap.values()),
    branches
  };
}

async function fetchGitHubJson(url, headers, tokenName = "") {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(await formatGitHubError(response, tokenName));
  }
  return response.json();
}

function compareBranchPriority(left, right, targetBranch, defaultBranch) {
  return getBranchPriority(right, targetBranch, defaultBranch) - getBranchPriority(left, targetBranch, defaultBranch) || left.localeCompare(right);
}

function getBranchPriority(branchName, targetBranch, defaultBranch) {
  if (branchName === targetBranch) {
    return 2;
  }
  if (branchName === defaultBranch) {
    return 1;
  }
  return 0;
}

function dedupeShas(shas) {
  const seen = new Set();
  const next = [];

  for (const sha of shas) {
    if (!sha || seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    next.push(sha);
  }

  return next;
}

function buildHeaders(token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function formatGitHubError(response, tokenName = "") {
  try {
    const data = await response.json();
    const prefix = tokenName ? `${tokenName}: ` : "";
    return prefix + (data.message || `GitHub API error (${response.status})`);
  } catch {
    return tokenName
      ? `${tokenName}: GitHub API error (${response.status})`
      : `GitHub API error (${response.status})`;
  }
}

async function getState() {
  const raw = await chrome.storage.sync.get({
    githubToken: "",
    tokens: [],
    enabledRepos: {}
  });

  const migratedTokens = Array.isArray(raw.tokens) ? raw.tokens : [];
  if (!migratedTokens.length && raw.githubToken) {
    const legacy = [
      {
        id: crypto.randomUUID(),
        name: "Default token",
        token: raw.githubToken
      }
    ];
    await chrome.storage.sync.set({ tokens: legacy, githubToken: "" });
    return {
      tokens: legacy,
      enabledRepos: raw.enabledRepos || {}
    };
  }

  return {
    tokens: migratedTokens,
    enabledRepos: raw.enabledRepos || {}
  };
}

async function saveNamedToken(name, token) {
  const cleanName = String(name || "").trim();
  const cleanToken = String(token || "").trim();
  if (!cleanName || !cleanToken) {
    throw new Error("Name and token are required.");
  }

  const state = await getState();
  const existingIndex = state.tokens.findIndex((entry) => entry.name.toLowerCase() === cleanName.toLowerCase());
  const nextEntry = {
    id: existingIndex >= 0 ? state.tokens[existingIndex].id : crypto.randomUUID(),
    name: cleanName,
    token: cleanToken
  };

  const nextTokens = [...state.tokens];
  if (existingIndex >= 0) {
    nextTokens[existingIndex] = nextEntry;
  } else {
    nextTokens.push(nextEntry);
  }

  await chrome.storage.sync.set({ tokens: nextTokens });
}

async function deleteNamedToken(id) {
  const state = await getState();
  const nextTokens = state.tokens.filter((entry) => entry.id !== id);
  await chrome.storage.sync.set({ tokens: nextTokens });
}

function dedupeCandidates(tokens) {
  const candidates = [{ name: "Public", token: "" }];
  const seen = new Set([""]);

  for (const entry of tokens || []) {
    if (!entry?.token || seen.has(entry.token)) {
      continue;
    }
    seen.add(entry.token);
    candidates.push({ name: entry.name || "Saved token", token: entry.token });
  }

  return candidates;
}
