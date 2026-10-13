import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { capabilities, fingerprint, renderIndex, scanStories, validateCatalog } from "./storybook-catalog.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "storybook-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(file, text) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  write("maps/feature-map/README.md", "# Features\n\n### Tasks and conversations\n\n| [Tasks](./tasks.md) | Tasks |\n");
  write("maps/feature-map/tasks.md", "# Tasks\n\n## Sub-features\n\n- `create`: create\n- `discussion`: discuss\n\n## How to get to it\n");
  write("ui/storybook/.storybook/preview.tsx", "// shared fixtures\n");
  const file = "ui/storybook/stories/tasks/task.stories.tsx";
  write(file, "// a story\n");
  write("ui/src/Task.tsx", "// production subject\n");
  const sharedSources = ["ui/storybook/.storybook/preview.tsx"];
  const sources = [file, "ui/src/Task.tsx"];
  const catalog = {
    version: 1, sharedReview: { sources: sharedSources, fingerprint: fingerprint(root, sharedSources) },
    entries: [{ file, stableId: "tasks-create", sidebarTitle: "Tasks and conversations/Tasks/Create", capabilities: ["tasks/create", "tasks/discussion"], purpose: "Create a task", status: "current",
      implementation: "production", boundary: "fixtures", notes: "Production subject; callbacks simulated.",
      reviewedAt: "2026-10-12", sources, fingerprint: fingerprint(root, sources) }],
  };
  const stories = [{ file, title: "Tasks and conversations/Tasks/Create", metaId: "tasks-create", ids: ["tasks-create--empty"], plays: 0 }];
  return { root, write, file, catalog, stories };
}

test("complete inventory accepts production subjects with simulated data", t => {
  const f = fixture(t);
  assert.deepEqual(validateCatalog(f.root, f.catalog, f.stories), []);
});

test("adding, removing or duplicating story files requires reconciliation", t => {
  const f = fixture(t);
  assert.match(validateCatalog(f.root, { ...f.catalog, entries: [] }, f.stories).join("\n"), /missing from catalog/);
  assert.match(validateCatalog(f.root, f.catalog, []).join("\n"), /missing story file/);
  f.catalog.entries.push(f.catalog.entries[0]);
  assert.match(validateCatalog(f.root, f.catalog, f.stories).join("\n"), /duplicate catalog entry/);
});

test("capability renames and unjustified unmapped stories fail", t => {
  const f = fixture(t);
  f.catalog.entries[0].capabilities = ["tasks/old-name"];
  assert.match(validateCatalog(f.root, f.catalog, f.stories).join("\n"), /unknown feature capability/);
  f.catalog.entries[0].capabilities = [];
  assert.match(validateCatalog(f.root, f.catalog, f.stories).join("\n"), /explicit reason/);
  f.catalog.entries[0].exception = "Shared foundation";
  const file = "ui/storybook/stories/foundations/task.stories.tsx";
  f.write(file, "export default {};");
  const entry = f.catalog.entries[0];
  entry.file = file;
  entry.sources = [file, "ui/src/Task.tsx"];
  entry.fingerprint = fingerprint(f.root, entry.sources);
  entry.sidebarTitle = "Foundations/Task";
  f.stories[0].file = file;
  f.stories[0].title = entry.sidebarTitle;
  assert.deepEqual(validateCatalog(f.root, f.catalog, f.stories), []);
});

test("feature organization rejects wrong folders, sidebar homes and unstable meta IDs", t => {
  const f = fixture(t);
  f.catalog.entries[0].capabilities = ["tasks/discussion"];
  assert.deepEqual(validateCatalog(f.root, f.catalog, f.stories), []);
  f.stories[0].metaId = "renamed-task";
  assert.match(validateCatalog(f.root, f.catalog, f.stories).join("\n"), /explicit meta ID/);
  f.stories[0].metaId = "tasks-create";
  f.stories[0].title = "Unrelated/Task";
  assert.match(validateCatalog(f.root, f.catalog, f.stories).join("\n"), /sidebar title/);
  f.stories[0].title = f.catalog.entries[0].sidebarTitle;
  const originalFile = f.catalog.entries[0].file;
  f.catalog.entries[0].file = "ui/storybook/stories/foundations/task.stories.tsx";
  assert.match(validateCatalog(f.root, f.catalog, f.stories).join("\n"), /primary feature folder tasks/);
  f.catalog.entries[0].file = originalFile;
  f.write("maps/feature-map/README.md", "### Conversations\n| [Tasks](./tasks.md) | Tasks |\n");
  assert.match(validateCatalog(f.root, f.catalog, f.stories).join("\n"), /sidebar title/);
});

test("production and shared fixture drift invalidate review fingerprints", t => {
  const f = fixture(t);
  f.write("ui/src/Task.tsx", "// changed contract\n");
  f.write("ui/storybook/.storybook/preview.tsx", "// changed shared mocks\n");
  const errors = validateCatalog(f.root, f.catalog, f.stories);
  assert.equal(errors.filter(error => error.includes("source changed")).length, 2);
  assert.equal(f.catalog.entries[0].fingerprint.length, 64);
});

test("missing and escaping source references cannot certify a review", t => {
  const f = fixture(t);
  f.catalog.entries[0].sources.push("../outside.ts");
  assert.match(validateCatalog(f.root, f.catalog, f.stories).join("\n"), /invalid review sources/);
});

test("cross-capability lookup retains one canonical file and honest status", t => {
  const f = fixture(t);
  f.catalog.entries[0].status = "historical";
  const index = renderIndex(f.catalog, f.stories, capabilities(f.root));
  assert.match(index, /tasks\/create.*\(historical\)/);
  assert.match(index, /tasks\/discussion.*\(historical\)/);
  assert.match(index, /1 story files; 1 indexed stories/);
  assert.match(index, /historical \/ production \/ fixtures/);
});

test("duplicate story IDs cannot silently collapse distinct examples", t => {
  const f = fixture(t);
  f.stories[0].ids.push(f.stories[0].ids[0]);
  assert.match(validateCatalog(f.root, f.catalog, f.stories).join("\n"), /Duplicate story IDs/);
});

test("Storybook parser discovers nested files, filters helpers, preserves explicit IDs and counts play functions", t => {
  const f = fixture(t);
  f.write("ui/package.json", '{"type":"module"}');
  symlinkSync(fileURLToPath(new URL("../ui/node_modules", import.meta.url)), path.join(f.root, "ui/node_modules"), "junction");
  f.write(f.file, `
    import type { Meta, StoryObj } from "@storybook/react-vite";
    const meta = { title: "Tasks/Create", id: "stable-task", excludeStories: ["empty"] } satisfies Meta;
    export default meta;
    type Story = StoryObj<typeof meta>;
    export const empty = { value: "fixture" };
    export const Empty: Story = {};
    export const Filled: Story = { play: async () => {} };
  `);
  f.write("ui/storybook/stories/nested/other.stories.ts", `
    export default { title: "Other/Subject", includeStories: ["Included"] };
    export const helper = {};
    export const Included = {};
  `);
  f.write("ui/storybook/stories/nested/fixture.ts", "export const fixture = {};");
  const stories = scanStories(f.root);
  assert.equal(stories.length, 2);
  assert.deepEqual(stories.find(story => story.file === f.file), {
    file: f.file, title: "Tasks/Create", metaId: "stable-task", ids: ["stable-task--empty", "stable-task--filled"], plays: 1,
  });
  assert.deepEqual(stories.find(story => story.file.endsWith("other.stories.ts")), {
    file: "ui/storybook/stories/nested/other.stories.ts", title: "Other/Subject", metaId: undefined, ids: ["other-subject--included"], plays: 0,
  });
});
