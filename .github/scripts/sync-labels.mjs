import { readFile, appendFile } from "node:fs/promises";

const API_BASE = "https://api.github.com";
const CONFIG_PATH = new URL("../labels.json", import.meta.url);
const token = process.env.LABEL_SYNC_TOKEN || process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error("LABEL_SYNC_TOKEN or GITHUB_TOKEN is required.");
}

const config = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
const canonicalLabels = new Map(config.labels.map((label) => [label.name, label]));
const migrationRules = new Map(
  (config.migrations ?? []).map((entry) => [entry.repository, entry.aliases ?? []]),
);

function splitRepo(fullName) {
  const [owner, repo] = fullName.split("/");
  return { owner, repo };
}

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "rallyon-label-sync",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${method} ${path} failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

async function paginate(path) {
  const items = [];
  let page = 1;

  while (true) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await api(`${path}${separator}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) {
      break;
    }
    page += 1;
  }

  return items;
}

async function listLabels(repository) {
  const { owner, repo } = splitRepo(repository);
  const labels = await paginate(`/repos/${owner}/${repo}/labels`);
  return new Map(labels.map((label) => [label.name, label]));
}

function findCaseInsensitiveLabel(existingLabels, targetName) {
  const normalized = targetName.toLowerCase();
  for (const label of existingLabels.values()) {
    if (label.name.toLowerCase() === normalized) {
      return label;
    }
  }
  return null;
}

async function ensureLabel(repository, label, existingLabels, summary) {
  const { owner, repo } = splitRepo(repository);
  const existing = existingLabels.get(label.name) ?? findCaseInsensitiveLabel(existingLabels, label.name);

  if (!existing) {
    await api(`/repos/${owner}/${repo}/labels`, {
      method: "POST",
      body: {
        name: label.name,
        color: label.color,
        description: label.description,
      },
    });
    summary.created.push(label.name);
    existingLabels.set(label.name, {
      name: label.name,
      color: label.color,
      description: label.description,
    });
    return;
  }

  const sameColor = existing.color.toLowerCase() === label.color.toLowerCase();
  const sameDescription = (existing.description ?? "") === label.description;
  const sameName = existing.name === label.name;

  if (sameColor && sameDescription && sameName) {
    summary.unchanged.push(label.name);
    return;
  }

  await api(`/repos/${owner}/${repo}/labels/${encodeURIComponent(existing.name)}`, {
    method: "PATCH",
    body: {
      new_name: label.name,
      color: label.color,
      description: label.description,
    },
  });
  summary.updated.push(existing.name === label.name ? label.name : `${existing.name} -> ${label.name}`);
  existingLabels.delete(existing.name);
  existingLabels.set(label.name, {
    name: label.name,
    color: label.color,
    description: label.description,
  });
}

async function listIssuesWithLabel(repository, labelName) {
  const { owner, repo } = splitRepo(repository);
  const issues = await paginate(
    `/repos/${owner}/${repo}/issues?state=all&labels=${encodeURIComponent(labelName)}`,
  );
  return issues.filter((issue) => !issue.pull_request);
}

async function addLabelToIssue(repository, issueNumber, labelName) {
  const { owner, repo } = splitRepo(repository);
  await api(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: "POST",
    body: {
      labels: [labelName],
    },
  });
}

async function removeLabelFromIssue(repository, issueNumber, labelName) {
  const { owner, repo } = splitRepo(repository);
  try {
    await api(`/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`, {
      method: "DELETE",
    });
  } catch (error) {
    if (!String(error).includes("404")) {
      throw error;
    }
  }
}

async function deleteLabel(repository, labelName, summary) {
  const { owner, repo } = splitRepo(repository);
  try {
    await api(`/repos/${owner}/${repo}/labels/${encodeURIComponent(labelName)}`, {
      method: "DELETE",
    });
    summary.deletedAliases.push(labelName);
  } catch (error) {
    if (!String(error).includes("404")) {
      throw error;
    }
  }
}

async function migrateAliases(repository, aliases, existingLabels, summary) {
  for (const alias of aliases) {
    if (!existingLabels.has(alias.from)) {
      continue;
    }

    const target = canonicalLabels.get(alias.to);
    if (!target) {
      throw new Error(`Unknown canonical label: ${alias.to}`);
    }

    const issues = await listIssuesWithLabel(repository, alias.from);

    for (const issue of issues) {
      await addLabelToIssue(repository, issue.number, alias.to);
      await removeLabelFromIssue(repository, issue.number, alias.from);
      summary.migrated.push(`#${issue.number}: ${alias.from} -> ${alias.to}`);
    }

    await deleteLabel(repository, alias.from, summary);
    existingLabels.delete(alias.from);
  }
}

function renderRepoSummary(repository, summary) {
  const lines = [
    `### ${repository}`,
    `- created: ${summary.created.length ? summary.created.join(", ") : "(none)"}`,
    `- updated: ${summary.updated.length ? summary.updated.join(", ") : "(none)"}`,
    `- unchanged: ${summary.unchanged.length ? summary.unchanged.join(", ") : "(none)"}`,
    `- migrated: ${summary.migrated.length ? summary.migrated.join("; ") : "(none)"}`,
    `- removed aliases: ${summary.deletedAliases.length ? summary.deletedAliases.join(", ") : "(none)"}`,
  ];
  return lines.join("\n");
}

const summaries = [];

for (const repository of config.repositories) {
  const summary = {
    created: [],
    updated: [],
    unchanged: [],
    migrated: [],
    deletedAliases: [],
  };

  const existingLabels = await listLabels(repository);

  for (const label of config.labels) {
    await ensureLabel(repository, label, existingLabels, summary);
  }

  await migrateAliases(repository, migrationRules.get(repository) ?? [], existingLabels, summary);

  const rendered = renderRepoSummary(repository, summary);
  console.log(rendered);
  console.log("");
  summaries.push(rendered);
}

if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summaries.join("\n\n")}\n`);
}
