const VISUALIZATION_THEME = `<style id="agent-webui-visualization-theme">
:root {
  color-scheme: light dark;
  --background: #ffffff;
  --foreground: #111827;
  --muted-foreground: #6b7280;
  --border: #d1d5db;
  --viz-series-1: #2563eb;
  --viz-series-2: #f59e0b;
  --viz-series-3: #10b981;
  --viz-series-4: #8b5cf6;
}
html, body {
  margin: 0;
  box-sizing: border-box;
  background: var(--background);
  color: var(--foreground);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
body { padding: 12px; }
@media (prefers-color-scheme: dark) {
  :root {
    --background: #1f1f1f;
    --foreground: #f3f4f6;
    --muted-foreground: #9ca3af;
    --border: #4b5563;
    --viz-series-1: #60a5fa;
    --viz-series-2: #fbbf24;
    --viz-series-3: #34d399;
    --viz-series-4: #a78bfa;
  }
}
</style>`;

export function themedVisualizationHtml(source: string): string {
  if (/<head(?:\s[^>]*)?>/i.test(source)) {
    return source.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${VISUALIZATION_THEME}`);
  }
  if (/<html(?:\s[^>]*)?>/i.test(source)) {
    return source.replace(
      /<html(?:\s[^>]*)?>/i,
      match => `${match}<head><meta charset="utf-8">${VISUALIZATION_THEME}</head>`,
    );
  }
  return `<!doctype html><html><head><meta charset="utf-8">${VISUALIZATION_THEME}</head><body>${source}</body></html>`;
}
