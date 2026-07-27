declare module "markdown-it-task-lists" {
  import type { PluginWithOptions } from "markdown-it";
  const plugin: PluginWithOptions<{ enabled?: boolean; label?: boolean; labelAfter?: boolean }>;
  export default plugin;
}

declare module "markdown-it-texmath" {
  import type { PluginWithOptions } from "markdown-it";
  interface TexmathOptions {
    engine: unknown;
    delimiters?: string | string[];
    katexOptions?: Record<string, unknown>;
  }
  const plugin: PluginWithOptions<TexmathOptions>;
  export default plugin;
}
