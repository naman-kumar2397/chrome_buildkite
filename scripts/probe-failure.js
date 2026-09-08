// Paste this into the DevTools console on a FAILED Buildkite build page.
//
// It reports which of the endpoints in failure.js actually answer on your
// organisation: the build JSON's shape, which jobs it says failed and what
// URL-ish fields they carry, every job-log candidate with its status and
// content type, and whether annotations exist. Buildkite's internal paths are
// undocumented and differ between payload shapes, so `jobLogUrls` tries
// several — this says which ones can be dropped.
//
// Organisation and pipeline names are replaced in the output. Log content is
// not printed beyond the first 160 characters of each response, but read what
// it prints before pasting it anywhere. The full objects are left on
// `window.__bk` for a closer look that stays in your browser.

(async () => {
  const j = (url, accept = 'application/json') =>
    fetch(url, { credentials: 'include', cache: 'no-store', headers: { Accept: accept } });

  const buildUrl = location.origin + location.pathname.match(/^\/[^/]+\/[^/]+\/builds\/\d+/)[0];
  const [, org, pipeline, number] = location.pathname.match(/^\/([^/]+)\/([^/]+)\/builds\/(\d+)/);
  const out = { buildUrl: buildUrl.replace(org, 'ORG').replace(pipeline, 'PIPELINE') };

  // ---- 1. the build JSON -------------------------------------------------
  let build = null;
  try {
    const r = await j(buildUrl + '.json');
    out.buildJson = { status: r.status, contentType: r.headers.get('content-type') };
    build = await r.json();
    build = build.build ?? build;
    out.buildJson.keys = Object.keys(build).sort();
    out.buildJson.state = build.state;
  } catch (e) { out.buildJson = { error: String(e) }; }

  // ---- 2. jobs and which of them failed -----------------------------------
  const jobs = build?.jobs ?? build?.steps ?? [];
  out.jobs = { count: jobs.length, keysOfFirst: jobs[0] ? Object.keys(jobs[0]).sort() : null };
  const failed = jobs.filter((x) => x && (x.exit_status != null && x.exit_status !== 0
    || /fail|broken|timed_out|timing_out/i.test(x.state ?? '')));
  out.jobs.failed = failed.map((x) => ({
    name: x.name ?? x.label ?? x.command?.slice(0, 40),
    state: x.state, exit_status: x.exit_status, soft_failed: x.soft_failed, type: x.type,
    urlish: Object.fromEntries(Object.entries(x)
      .filter(([k, v]) => typeof v === 'string' && (/path|url|href/i.test(k)) && v)
      .map(([k, v]) => [k, v.replace(org, 'ORG').replace(pipeline, 'PIPELINE')])),
  }));

  // ---- 3. where does a job log live? --------------------------------------
  const job = failed[0] ?? jobs.find((x) => x?.id ?? x?.uuid);
  const id = job?.id ?? job?.uuid;
  const base = job?.base_path ?? job?.path;
  const candidates = [...new Set([
    base && location.origin + (base.startsWith('/') ? '' : '/') + base + '/log',
    base && location.origin + (base.startsWith('/') ? '' : '/') + base + '/raw_log',
    id && `${buildUrl}/jobs/${id}/log`,
    id && `${buildUrl}/jobs/${id}/raw_log`,
    id && `${location.origin}/organizations/${org}/pipelines/${pipeline}/builds/${number}/jobs/${id}/log`,
    id && `${location.origin}/organizations/${org}/pipelines/${pipeline}/builds/${number}/jobs/${id}/raw_log`,
  ].filter(Boolean))];

  out.logProbes = [];
  for (const url of candidates) {
    try {
      const r = await j(url, 'application/json, text/plain');
      const ct = (r.headers.get('content-type') || '').split(';')[0];
      const text = await r.text();
      let shape = 'text';
      try { const b = JSON.parse(text); shape = 'json:' + Object.keys(b).slice(0, 12).join(','); } catch { /* text */ }
      out.logProbes.push({
        url: url.replace(org, 'ORG').replace(pipeline, 'PIPELINE').replace(id ?? '', 'JOBID'),
        status: r.status, contentType: ct, bytes: text.length, shape,
        head: text.slice(0, 160),
      });
    } catch (e) {
      out.logProbes.push({ url: url.replace(org, 'ORG').replace(pipeline, 'PIPELINE'), error: String(e) });
    }
  }

  // ---- 4. annotations (Buildkite's own curated failure summary) -----------
  out.annotations = { inBuildJson: Array.isArray(build?.annotations) ? build.annotations.length : 'absent' };
  for (const path of ['/annotations', '/annotations.json']) {
    try {
      const r = await j(buildUrl + path);
      const t = await r.text();
      out.annotations[path] = {
        status: r.status, contentType: (r.headers.get('content-type') || '').split(';')[0],
        bytes: t.length, head: t.slice(0, 200),
      };
    } catch (e) { out.annotations[path] = String(e); }
  }

  window.__bk = { build, jobs, failed, out };
  console.log(JSON.stringify(out, null, 2));
  console.log('full objects kept in window.__bk');
})();
