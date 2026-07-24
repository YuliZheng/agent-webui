declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";

  interface TaskListOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }

  const taskLists: (md: MarkdownIt, options?: TaskListOptions) => void;
  export default taskLists;
}

declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";

  interface TexMathOptions {
    engine: {
      renderToString(source: string, options?: Record<string, unknown>): string;
    };
    delimiters?: string | string[];
    katexOptions?: Record<string, unknown>;
  }

  const texmath: (md: MarkdownIt, options: TexMathOptions) => void;
  export default texmath;
}
