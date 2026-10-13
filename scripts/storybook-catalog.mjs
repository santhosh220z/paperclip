#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const storyRoot = "ui/storybook/stories";
const catalogPath = "maps/storybook-map/catalog.json";
const indexPath = "maps/storybook-map/INDEX.md";
const statuses = ["current", "proposed", "historical", "mixed", "unreviewed"];
const implementations = ["production", "prototype", "mixed", "guide"];
const boundaries = ["fixtures", "fixture-server", "static"];

function files(root, dir) {
  return readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => {
    const name = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(root, name) : [name];
  }).sort();
}

export function fingerprint(root, sources) {
  const hash = createHash("sha256");
  for (const file of [...new Set(sources)].sort()) {
    hash.update(file).update("\0").update(readFileSync(path.join(root, file))).update("\0");
  }
  return hash.digest("hex");
}

export function capabilities(root) {
  const result = new Map();
  for (const file of files(root, "maps/feature-map").filter(file => file.endsWith(".md") && !file.endsWith("README.md"))) {
    const text = readFileSync(path.join(root, file), "utf8");
    const area = path.basename(file, ".md");
    const section = text.split(/^## Sub-features\s*$/m)[1]?.split(/^## /m)[0] ?? "";
    for (const match of section.matchAll(/^- `([^`]+)`:/gm)) result.set(`${area}/${match[1]}`, file);
  }
  return result;
}

export function featureNavigation(root) {
  const navigation = new Map();
  let section;
  for (const line of readFileSync(path.join(root, "maps/feature-map/README.md"), "utf8").split("\n")) {
    if (line.startsWith("### ")) section = line.slice(4);
    const match = line.match(/^\| \[([^\]]+)\]\(\.\/([^.)]+)\.md\)/);
    if (match && section) navigation.set(match[2], `${section}/${match[1]}`);
  }
  return navigation;
}

export function scanStories(root = defaultRoot) {
  const require = createRequire(path.join(root, "ui/package.json"));
  const { loadCsf } = require("storybook/internal/csf-tools");
  return files(root, storyRoot).filter(file => /\.stories\.(ts|tsx|mdx)$/.test(file)).map(file => {
    const csf = loadCsf(readFileSync(path.join(root, file), "utf8"), { fileName: file, makeTitle: title => title }).parse();
    return { file, title: csf.meta.title, metaId: csf.meta.id, ids: csf.stories.map(story => story.id), plays: csf.stories.filter(story => story.__stats?.play).length };
  });
}

export function validateCatalog(root, catalog, stories) {
  const errors = [];
  const refs = capabilities(root);
  const navigation = featureNavigation(root);
  const byFile = new Map(stories.map(story => [story.file, story]));
  const seen = new Set();
  const local = file => typeof file === "string" && !path.isAbsolute(file) && !file.split("/").includes("..") && existsSync(path.join(root, file));
  if (catalog.version !== 1 || !Array.isArray(catalog.entries)) return ["Unsupported catalog version or missing entries"];
  function review(label, sources, hash) {
    if (!Array.isArray(sources) || !sources.length || sources.some(file => !local(file))) {
      errors.push(`${label}: missing/invalid review sources`);
    } else if (fingerprint(root, sources) !== hash) errors.push(`${label}: source changed; review before updating its fingerprint`);
  }
  review("Shared Storybook setup", catalog.sharedReview?.sources, catalog.sharedReview?.fingerprint);
  for (const entry of catalog.entries) {
    const label = entry.file;
    if (seen.has(label)) errors.push(`${label}: duplicate catalog entry`);
    seen.add(label);
    if (!byFile.has(label)) errors.push(`${label}: missing story file`);
    if (!statuses.includes(entry.status)) errors.push(`${label}: invalid product status`);
    if (!implementations.includes(entry.implementation)) errors.push(`${label}: invalid implementation`);
    if (!boundaries.includes(entry.boundary)) errors.push(`${label}: invalid data boundary`);
    if (!entry.purpose?.trim() || !entry.notes?.trim()) errors.push(`${label}: purpose and review notes are required`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedAt ?? "")) errors.push(`${label}: missing review date`);
    if (!Array.isArray(entry.capabilities)) { errors.push(`${label}: missing capabilities`); continue; }
    for (const ref of entry.capabilities) if (!refs.has(ref)) errors.push(`${label}: unknown feature capability ${ref}`);
    if (!entry.capabilities.length && !entry.exception?.trim()) errors.push(`${label}: unmapped story needs an explicit reason`);
    if (entry.capabilities.length !== new Set(entry.capabilities).size) errors.push(`${label}: duplicate capability references`);
    const area = entry.capabilities[0]?.split("/")[0] ?? (entry.implementation === "guide" ? "overview" : "foundations");
    const prefix = navigation.get(area) ?? ({ overview: "Overview", foundations: "Foundations" })[area];
    const story = byFile.get(label);
    if (!label.startsWith(`${storyRoot}/${area}/`)) errors.push(`${label}: story must live in its primary feature folder ${area}`);
    if (!prefix || !entry.sidebarTitle?.startsWith(`${prefix}/`) || story?.title !== entry.sidebarTitle) errors.push(`${label}: sidebar title must match its feature-map home`);
    if (!entry.stableId || story?.metaId !== entry.stableId) errors.push(`${label}: explicit meta ID must preserve the catalog stableId`);
    if (entry.replacement && !byFile.has(entry.replacement)) errors.push(`${label}: replacement story is missing`);
    if (!entry.sources?.includes(label)) errors.push(`${label}: review must include its story source`);
    review(label, entry.sources, entry.fingerprint);
  }
  for (const story of stories) if (!seen.has(story.file)) errors.push(`${story.file}: story missing from catalog`);
  const ids = stories.flatMap(story => story.ids);
  if (ids.length !== new Set(ids).size) errors.push("Duplicate story IDs");
  return errors;
}

function cell(value) { return String(value).replaceAll("|", "\\|").replaceAll("\n", " "); }

export function renderIndex(catalog, stories, refs) {
  const byFile = new Map(stories.map(story => [story.file, story]));
  const groups = new Map();
  for (const entry of catalog.entries) {
    const area = entry.capabilities[0]?.split("/")[0] ?? "foundations-and-guides";
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(entry);
  }
  const lines = ["# Storybook by feature", "", "<!-- Generated by node scripts/storybook-catalog.mjs --write. Edit catalog.json. -->", "",
    "[Contract and maintenance](README.md) · [Review findings](REVIEW.md)", "",
    `${stories.length} story files; ${stories.reduce((n, story) => n + story.ids.length, 0)} indexed stories. Counts describe inventory, not passed tests or complete feature coverage.`, "",
    "Status describes product alignment; implementation describes the rendered subject; boundary describes simulated data. Sources and limitations are in catalog.json. Related capabilities cross-list one canonical story file.", ""];
  for (const [area, entries] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${area}`, "", ...(area !== "foundations-and-guides" ? [`[Feature recipe](../feature-map/${area}.md)`, ""] : []),
      "| Story suite | Capabilities | Product / implementation / data | Stories / play functions | Review note |",
      "| --- | --- | --- | --- | --- |");
    for (const entry of entries.sort((a, b) => a.file.localeCompare(b.file))) {
      const story = byFile.get(entry.file);
      lines.push(`| [${cell(story.title)}](../../${entry.file}) | ${entry.capabilities.map(ref => `\`${ref}\``).join(", ") || cell(entry.exception)} | ${entry.status} / ${entry.implementation} / ${entry.boundary} | ${story.ids.length} / ${story.plays} | ${cell(entry.notes)} |`);
    }
    lines.push("");
  }
  lines.push("## Capability lookup", "", "References are navigation links, not proof of parity. An absent link means no cataloged story, not a missing product feature. CLI/operator capabilities may need no Storybook example.", "");
  for (const ref of refs.keys()) {
    const entries = catalog.entries.filter(entry => entry.capabilities.includes(ref));
    lines.push(`- \`${ref}\`: ${entries.length ? entries.map(entry => `[${cell(byFile.get(entry.file).title)}](../../${entry.file}) (${entry.status})`).join(", ") : "No cataloged story."}`);
  }
  return lines.join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== "--write")) throw new Error("Usage: node scripts/storybook-catalog.mjs [--write]");
  const catalog = JSON.parse(readFileSync(path.join(defaultRoot, catalogPath), "utf8"));
  const stories = scanStories();
  const errors = validateCatalog(defaultRoot, catalog, stories);
  if (!errors.length) {
    const generated = renderIndex(catalog, stories, capabilities(defaultRoot));
    if (args.includes("--write")) writeFileSync(path.join(defaultRoot, indexPath), generated);
    else if (!existsSync(path.join(defaultRoot, indexPath)) || readFileSync(path.join(defaultRoot, indexPath), "utf8") !== generated) errors.push("Generated INDEX.md is stale; run with --write after reviewing catalog changes");
  }
  if (errors.length) { errors.forEach(error => console.error(error)); process.exitCode = 1; }
  else console.log(`Storybook catalog aligned: ${stories.length} files, ${stories.reduce((n, story) => n + story.ids.length, 0)} stories. Structure and review fingerprints only; no runtime proof.`);
}
