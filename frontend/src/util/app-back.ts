export const APP_BACK_PRIORITY = {
  overlay: 100,
  sheet: 90,
  surface: 80,
  menu: 70,
} as const;

type AppBackHandler = () => boolean;

interface RegisteredHandler {
  id: number;
  priority: number;
  handler: AppBackHandler;
}

const handlers: RegisteredHandler[] = [];
let nextHandlerId = 1;

export function registerAppBackHandler(
  handler: AppBackHandler,
  priority: number = APP_BACK_PRIORITY.menu,
): () => void {
  const entry = { id: nextHandlerId++, priority, handler };
  handlers.push(entry);
  return () => {
    const index = handlers.findIndex(candidate => candidate.id === entry.id);
    if (index >= 0) handlers.splice(index, 1);
  };
}

export function dispatchAppBack(fallback?: AppBackHandler): boolean {
  const ordered = [...handlers].sort(
    (a, b) => b.priority - a.priority || b.id - a.id,
  );
  for (const entry of ordered) {
    if (entry.handler()) return true;
  }
  return fallback?.() ?? false;
}
