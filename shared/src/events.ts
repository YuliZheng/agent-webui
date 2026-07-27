import type {
  BackgroundTask,
  Interaction,
  ProcessStatus,
  SessionListItem,
  StreamWireLine,
} from "./api.js";

interface PushBase<K extends string> {
  type: K;
  kind: K;
}

export type NotificationBaselinePush = PushBase<"notif-baseline"> & {
  seq: number;
};

export type NotificationPush = PushBase<"notification"> & {
  id: string;
  cwd: string;
  title: string;
  body: string;
  uuid: string;
  timestamp: string;
  seq: number;
  peer?: boolean;
};

export type SessionAddedPush = PushBase<"session-added"> & {
  session: SessionListItem;
};

export type SessionTouchedPush = PushBase<"session-touched"> & {
  id: string;
  session?: Partial<SessionListItem>;
};

export type SessionRenamedPush = PushBase<"session-renamed"> & {
  id: string;
  title: string | null;
  titleSource?: "auto" | "manual" | null;
  emoji?: string | null;
};

export type SessionStatusPush = PushBase<"session-status"> & {
  id: string;
  status: ProcessStatus | null;
  webuiAlive: boolean;
  compacting?: boolean;
};

export type SessionBoundaryPush = PushBase<"session-boundary"> & {
  id: string;
  at: string;
};

export type SessionReadPush = PushBase<"session-read"> & {
  id: string;
  at: string;
};

export type SessionRetitlingPush = PushBase<"session-retitling"> & {
  id: string;
  inflight: boolean;
};

export type SessionSettingsPush = PushBase<"session-settings"> & {
  id: string;
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  permissionMode: string | null;
  sandboxMode: string | null;
};

export type SessionErrorPush = PushBase<"session-error"> & {
  sessionId: string;
  turnId: string | null;
  agent: "claude" | "codex";
  message: string;
  details: string | null;
};

export type InteractionAddedPush = PushBase<"interaction-added"> & {
  interaction: Interaction;
};

export type InteractionRemovedPush = PushBase<"interaction-removed"> & {
  sessionId: string;
  requestId: string;
  reason?: "answered" | "cancelled" | "process-died" | "superseded";
};

export type BackgroundTasksPush = PushBase<"background-tasks"> & {
  sessionId: string;
  tasks: BackgroundTask[];
};

export type GlobalPushEvent =
  | NotificationBaselinePush
  | NotificationPush
  | SessionAddedPush
  | SessionTouchedPush
  | SessionRenamedPush
  | SessionStatusPush
  | SessionBoundaryPush
  | SessionReadPush
  | SessionRetitlingPush
  | SessionSettingsPush
  | SessionErrorPush
  | InteractionAddedPush
  | InteractionRemovedPush
  | BackgroundTasksPush;

export type StreamLinePush = PushBase<"stream-line"> & {
  sessionId: string;
  index: number;
  data: string;
};

export type StreamBatchPush = PushBase<"stream-batch"> & {
  sessionId: string;
  lines: StreamWireLine[];
};

export type StreamResetPush = PushBase<"stream-reset"> & {
  sessionId: string;
};

export type StreamTruncatePush = PushBase<"stream-truncate"> & {
  sessionId: string;
  keepCount: number;
};

export type PongPush = PushBase<"pong"> & { seq: number };

export type SessionStreamPushEvent =
  | StreamLinePush
  | StreamBatchPush
  | StreamResetPush
  | StreamTruncatePush;

export type PushEvent = GlobalPushEvent | SessionStreamPushEvent | PongPush;

const GLOBAL_PUSH_TYPES: ReadonlySet<string> = new Set([
  "notif-baseline",
  "notification",
  "session-added",
  "session-touched",
  "session-renamed",
  "session-status",
  "session-boundary",
  "session-read",
  "session-retitling",
  "session-settings",
  "session-error",
  "interaction-added",
  "interaction-removed",
  "background-tasks",
]);

export function isGlobalPushEvent(value: unknown): value is GlobalPushEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return (
    typeof event.type === "string" &&
    event.kind === event.type &&
    GLOBAL_PUSH_TYPES.has(event.type)
  );
}
