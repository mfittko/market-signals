---
name: briefing-publisher
description: Publish generated markdown briefings to a GitHub Pages repository with sortable UTC timestamp paths and a stable latest.md pointer. Use for hourly/daily/custom cadence by setting series path (for example market, sentinel, geopolitics).
---

# Briefing publisher

Use `scripts/publish_briefing.mjs` to publish a local markdown report into a GitHub repository (default: `mfittko/ai-briefings`) via GitHub API, without needing a local git checkout.

> **Note (issue #91):** the FXEmpire raw news/articles channel that used to back the
> `market` series (`fxempire-market-analysis-24h.md`) is deprecated as a source — it
> dried out (stale scrape, see #11/#28). The primary input is now
> `skills/market-sentinel/scripts/sentinel_briefing.mjs`'s markdown digest, published
> as `--series sentinel`. The generic `market`/fxempire series path still works if
> anything still produces that input; it's just no longer the default.

## Quick start

```bash
node skills/market-sentinel/scripts/sentinel_briefing.mjs --output-file $WORKSPACE_DIR/sentinel/sentinel-briefing.md

export GH_TOKEN="..."  # repo scope
node skills/briefing-publisher/scripts/publish_briefing.mjs \
  --input-file $WORKSPACE_DIR/sentinel/sentinel-briefing.md \
  --series sentinel
```

## What it publishes

For each run, the script creates:

- `docs/reports/<series>/<YYYY>/<MM>/<YYYY-MM-DDTHHMMSSZ>.md`
- `docs/reports/<series>/latest.md`
- `docs/reports/<series>/index.md` (updated with newest entry)
- `docs/reports/<series>/feed.xml` (RSS 2.0 for the series)
- `docs/feed.xml` (root feed; mirrors current series feed)

This gives sortable archives plus a stable latest link.

Feed URLs:

- `https://mfittko.github.io/ai-briefings/reports/<series>/feed.xml`
- `https://mfittko.github.io/ai-briefings/feed.xml`

## Cadence examples

Sentinel digest (primary, flat series path):

```bash
node skills/market-sentinel/scripts/sentinel_briefing.mjs --output-file $WORKSPACE_DIR/sentinel/sentinel-briefing.md
node skills/briefing-publisher/scripts/publish_briefing.mjs \
  --input-file $WORKSPACE_DIR/sentinel/sentinel-briefing.md \
  --series sentinel
```

Hourly sentinel digest (same series, more files):

```bash
node skills/market-sentinel/scripts/sentinel_briefing.mjs --hours 1 --output-file $WORKSPACE_DIR/sentinel/sentinel-briefing.md
node skills/briefing-publisher/scripts/publish_briefing.mjs \
  --input-file $WORKSPACE_DIR/sentinel/sentinel-briefing.md \
  --series sentinel/hourly
```

Legacy fxempire market series (deprecated source, kept working if something still produces this input):

```bash
node skills/briefing-publisher/scripts/publish_briefing.mjs \
  --input-file $WORKSPACE_DIR/market/fxempire-market-analysis-24h.md \
  --series market
```

## Options

- `--input-file <path>` (required): markdown file to publish
- `--series <path>` (default: `market`): logical path under `docs/reports/`
- `--repo <owner/name>` (default: `mfittko/ai-briefings`)
- `--branch <name>` (default: `main`)
- `--site-base-url <url>` (default: `https://mfittko.github.io/ai-briefings`)
- `--token-env <ENV_NAME>` (default: `GH_TOKEN`)
- `--timestamp <ISO_8601>` (optional override for deterministic paths)
- `--dry-run` (no remote writes, prints computed paths)

## Auth

Token lookup order:

1. env named by `--token-env` (default `GH_TOKEN`)
2. `BRIEFINGS_GH_TOKEN`
3. `GITHUB_TOKEN`

Token needs `repo` scope for private writes or public repo content write rights.

## Output

Prints JSON with:

- `repo`, `branch`, `series`
- `archivePath`, `latestPath`, `indexPath`
- `archiveUrl`, `latestUrl`

