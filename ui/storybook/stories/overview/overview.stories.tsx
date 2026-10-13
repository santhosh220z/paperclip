import { useEffect, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import catalog from "../../../../maps/storybook-map/catalog.json";

type IndexEntry = { id: string; type: string; importPath: string };

function StorybookGuide() {
  const [query, setQuery] = useState("");
  const [storyLinks, setStoryLinks] = useState<Record<string, string>>({});
  const [indexError, setIndexError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(new URL("index.json", window.location.href), { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error("Story index unavailable");
        return response.json() as Promise<{ entries: Record<string, IndexEntry> }>;
      })
      .then(index => {
        const links: Record<string, string> = {};
        for (const entry of Object.values(index.entries)) {
          if (entry.type !== "story") continue;
          const file = `ui/${entry.importPath.replace(/^\.\//, "")}`;
          links[file] ??= `./?path=/story/${entry.id}`;
        }
        setStoryLinks(links);
      })
      .catch(() => { if (!controller.signal.aborted) setIndexError(true); });
    return () => controller.abort();
  }, []);
  const groups = useMemo(() => {
    const result = new Map<string, typeof catalog.entries>();
    const search = query.trim().toLowerCase();
    for (const entry of catalog.entries) {
      if (search && ![entry.purpose, entry.file, entry.status, entry.implementation, ...entry.capabilities].join(" ").toLowerCase().includes(search)) continue;
      const area = entry.capabilities[0]?.split("/")[0] ?? "foundations-and-guides";
      const entries = result.get(area) ?? [];
      entries.push(entry);
      result.set(area, entries);
    }
    return [...result].sort(([a], [b]) => a.localeCompare(b));
  }, [query]);
  return (
    <main className="paperclip-story__inner space-y-6 p-6">
      <header className="space-y-3">
        <h1 className="text-2xl font-semibold">Storybook by feature</h1>
        <p className="text-sm text-muted-foreground">
          {catalog.entries.length} story suites organized by the feature map. Current means source-reviewed;
          it does not mean every interaction or production journey passed. Production components can use simulated data.
        </p>
        <p className="text-sm text-muted-foreground">
          Historical designs and proposals stay available. Unreviewed entries need deeper comparison with the current product.
          The maintained contract and full source references are in maps/storybook-map/.
        </p>
        <Input aria-label="Find stories by feature, title, or status" placeholder="Find a feature, story, or status…" value={query} onChange={event => setQuery(event.target.value)} />
        {indexError ? <p role="alert" className="text-sm text-destructive">Story links could not load. Reload this guide to try again.</p> : null}
      </header>
      {groups.length === 0 ? <p className="text-sm text-muted-foreground">No matching stories.</p> : null}
      {groups.map(([area, entries]) => (
        <section key={area} className="space-y-3">
          <h2 className="text-lg font-semibold">{area}</h2>
          <ul className="divide-y divide-border">
            {entries.map(entry => (
              <li key={entry.file} className="space-y-2 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  {storyLinks[entry.file]
                    ? <a className="font-medium underline underline-offset-4" href={storyLinks[entry.file]} target="_top">{entry.purpose}</a>
                    : <span className="font-medium">{entry.purpose}</span>}
                  <Badge variant="outline">{entry.status}</Badge>
                  <Badge variant="outline">{entry.implementation}</Badge>
                  <Badge variant="outline">{entry.boundary}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">{entry.notes}</p>
                <p className="font-mono text-xs text-muted-foreground">{entry.capabilities.join(" · ") || "Shared foundations and contributor guidance"}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

const meta = {
  id: "overview-storybook-guide",
  title: "Overview/Storybook Guide",
  component: StorybookGuide,
  parameters: { docs: { description: { component: "Feature-based navigation from the downstream catalog, with separate product, component, and fixture classifications. Story links come from this build's index." } } },
} satisfies Meta<typeof StorybookGuide>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CoverageGuide: Story = {};
