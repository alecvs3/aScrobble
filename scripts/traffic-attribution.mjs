import { appendFile } from "node:fs/promises";

const { GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_STEP_SUMMARY } = process.env;
const trafficToken = process.env.TRAFFIC_TOKEN || GITHUB_TOKEN;
const apiUrl = process.env.GITHUB_API_URL || "https://api.github.com";
const statsBranch = "github-repo-stats";
const repoPath = `/repos/${GITHUB_REPOSITORY}`;
const now = new Date();
const day = (timestamp) => timestamp.slice(0, 10);

if (!GITHUB_REPOSITORY || !GITHUB_TOKEN) {
  throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required");
}

async function request(path, options = {}) {
  const { token = GITHUB_TOKEN, method = "GET", body } = options;
  const response = await fetch(`${apiUrl}${repoPath}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok) throw new Error(`GitHub ${method} ${path} returned HTTP ${response.status}`);
  return { data: await response.json(), link: response.headers.get("link") ?? "" };
}

async function list(path, getEntries = (data) => data) {
  const entries = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; ; page++) {
    const { data, link } = await request(`${path}${separator}per_page=100&page=${page}`);
    entries.push(...getEntries(data));
    if (!link.includes('rel="next"')) return entries;
  }
}

const [cloneResponse, viewResponse, referrerResponse, releases, forks] = await Promise.all([
  request("/traffic/clones", { token: trafficToken }),
  request("/traffic/views", { token: trafficToken }),
  request("/traffic/popular/referrers", { token: trafficToken }),
  list("/releases"),
  list("/forks"),
]);

const clones = cloneResponse.data;
const views = viewResponse.data;
const dates = [...new Set([...clones.clones, ...views.views].map(({ timestamp }) => day(timestamp)))].sort();
const workflowRuns = dates.length
  ? await list(`/actions/runs?created=${dates[0]}..${dates.at(-1)}`, (data) => data.workflow_runs)
  : [];

const daily = dates.map((date) => {
  const runs = workflowRuns.filter((run) => day(run.created_at) === date);
  const workflowRunsByName = new Map();
  for (const { name } of runs) {
    workflowRunsByName.set(name, (workflowRunsByName.get(name) ?? 0) + 1);
  }
  const cloneDay = clones.clones.find(({ timestamp }) => day(timestamp) === date);
  return {
    date,
    clones: cloneDay?.count ?? 0,
    uniqueCloners: cloneDay?.uniques ?? 0,
    views: views.views.find(({ timestamp }) => day(timestamp) === date)?.count ?? 0,
    workflowRuns: runs.length,
    workflowRunsByName: Object.fromEntries(workflowRunsByName),
    newPublicForks: forks.filter((fork) => day(fork.created_at) === date).length,
    releasesPublished: releases.filter((release) =>
      release.published_at && day(release.published_at) === date).length,
  };
});

const releaseAssets = releases.flatMap((release) => release.assets.map((asset) => ({
  id: asset.id,
  release: release.tag_name,
  name: asset.name,
  downloads: asset.download_count,
})));

const snapshot = {
  capturedAt: now.toISOString(),
  repository: GITHUB_REPOSITORY,
  traffic: {
    clones: clones.count,
    uniqueCloners: clones.uniques,
    views: views.count,
    uniqueVisitors: views.uniques,
    daily,
    pageReferrers: referrerResponse.data,
  },
  releaseAssets,
};

const stamp = day(snapshot.capturedAt);
const archive = `traffic-attribution/${stamp}.json`;
const reportOnly = process.argv.includes("--report-only");
if (!reportOnly) {
  const existing = await request(`/contents/${archive}?ref=${statsBranch}`, { allowMissing: true });
  await request(`/contents/${archive}`, {
    method: "PUT",
    body: {
      branch: statsBranch,
      message: `Archive clone context and download counts for ${stamp}`,
      content: Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`).toString("base64"),
      sha: existing?.data.sha,
    },
  });
}

const rows = [...daily].sort((left, right) => right.clones - left.clones).slice(0, 5);
const referrers = snapshot.traffic.pageReferrers
  .map(({ referrer, count }) => `${referrer} (${count})`).join(", ") || "None reported";
const previousSnapshot = GITHUB_STEP_SUMMARY
  ? `[Daily snapshots](${process.env.GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/tree/${statsBranch}/traffic-attribution)`
  : archive;
const summary = [
  "## Repository traffic",
  "",
  `In GitHub's latest traffic window: **${clones.count} clones**, **${clones.uniques} unique cloners**, and **${views.count} page views**.`,
  "",
  "| Peak dates (UTC) | Clones | Unique cloners | Page views | Actions runs | New public forks | Releases |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...rows.map((row) => `| ${row.date} | ${row.clones} | ${row.uniqueCloners} | ${row.views} | ${row.workflowRuns} | ${row.newPublicForks} | ${row.releasesPublished} |`),
  "",
  `Page referrers: ${referrers}.`,
  "",
  "GitHub provides aggregate clone counts. Actions runs, forks, releases, and page referrers provide context but cannot identify the origin of a clone.",
  "",
  reportOnly ? "Read-only report. No snapshot was written." : `Archived traffic and cumulative release asset counts. ${previousSnapshot}`,
  "",
].join("\n");

if (GITHUB_STEP_SUMMARY) await appendFile(GITHUB_STEP_SUMMARY, summary);
console.log(summary);
