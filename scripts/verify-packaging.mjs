#!/usr/bin/env node
// Smoke check for the two packaging layers (AC-5).
// Fails visibly (exit 1) if a manifest is broken or drifts from the canonical
// skills/ source. Node stdlib only, no deps.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const errors = [];
const fail = (m) => errors.push(m);

// 1. Canonical source of truth: skills/<name>/SKILL.md
const skillsDir = join(root, "skills");
const skillNames = readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md")))
  .map((d) => d.name)
  .sort();

if (skillNames.length === 0) fail("no skills found under skills/");

for (const name of skillNames) {
  const body = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) {
    fail(`skills/${name}/SKILL.md: frontmatter must start at byte 0 with '---'`);
    continue;
  }
  const end = body.indexOf("\n---", 3);
  const fm = end === -1 ? "" : body.slice(3, end);
  const declared = /^name:\s*(\S+)/m.exec(fm)?.[1];
  if (!declared) fail(`skills/${name}/SKILL.md: missing 'name:' in frontmatter`);
  else if (declared !== name) fail(`skills/${name}/SKILL.md: name '${declared}' != dir '${name}'`);
  if (!/^description:\s*\S/m.test(fm)) fail(`skills/${name}/SKILL.md: missing 'description:'`);
}

// 2. Claude plugin manifest
const readJson = (p) => {
  try { return JSON.parse(readFileSync(join(root, p), "utf8")); }
  catch (e) { fail(`${p}: ${e.message}`); return null; }
};
const plugin = readJson(".claude-plugin/plugin.json");
if (plugin && !plugin.name) fail(".claude-plugin/plugin.json: missing 'name'");
if (plugin && !plugin.version) fail(".claude-plugin/plugin.json: missing 'version'");

const market = readJson(".claude-plugin/marketplace.json");
if (market && !(Array.isArray(market.plugins) && market.plugins.length && market.plugins[0].source)) {
  fail(".claude-plugin/marketplace.json: needs plugins[] with a 'source'");
}

// 3. Pi manifest: provides_skills must match skills/ exactly (no drift, no dup).
// ponytail: line-parse the one list we need instead of adding a YAML dep.
const yaml = readFileSync(join(root, "plugin.yaml"), "utf8");
const listStart = yaml.indexOf("provides_skills:");
if (listStart === -1) fail("plugin.yaml: missing 'provides_skills:'");
else {
  const listed = yaml.slice(listStart).split("\n").slice(1)
    .filter((l) => /^\s*-\s+\S/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, "").trim())
    .sort();
  const missing = skillNames.filter((s) => !listed.includes(s));
  const extra = listed.filter((s) => !skillNames.includes(s));
  if (missing.length) fail(`plugin.yaml: provides_skills missing real skills: ${missing.join(", ")}`);
  if (extra.length) fail(`plugin.yaml: provides_skills lists non-existent skills: ${extra.join(", ")}`);
}

if (errors.length) {
  console.error(`FAIL packaging smoke check (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(`OK packaging smoke check: ${skillNames.length} skills, both manifests valid and in sync.`);
console.log(`  skills: ${skillNames.join(", ")}`);
