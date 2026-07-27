export type Status = "running" | "exited" | "failed";

export type GlobalEvent =
  | { kind: "session-added"; id: string; cwd: string; mtime: string; size: number; agent?: "claude" | "codex"; peer?: boolean; subagent?: boolean; title?: string | null; parentSessionId?: string | null; preview?: string | null; lastTurnAt?: string | null; lastBoundaryAt?: string | null }
  | { kind: "session-touched"; id: string; mtime: string; size: number; peer?: boolean; subagent?: boolean; preview?: string | null; lastTurnAt?: string | null; lastBoundaryAt?: string | null }
  | { kind: "session-renamed"; id: string; title: string | null; titleSource?: "auto" | "manual" | null; emoji?: string | null }
  | {
      kind: "session-status";
      id: string;
      // status is the combined "alive + mid-turn" signal (process running AND
      // last jsonl record / stream-parser says mid-turn). Drives the green
      // "Thinking…" pill and sidebar dot.
      status: Status | null;
      // True iff a webui-spawned (not foreign) claude process is currently
      // alive for this session. Independent of status: an idle long-lived
      // claude has status=null but webuiAlive=true. Drives the Kill pill.
      webuiAlive: boolean;
      // True while the CLI is running /compact for this session (wire-only
      // signal; the jsonl is silent for the whole compact window). Drives the
      // "Compacting…" label in place of the generic thinking indicator.
      compacting?: boolean;
    }
  | { kind: "session-boundary"; id: string; at: string }
  // A session was marked read on some device. Carries the read watermark
  // (the session's lastTurnAt at read time) so every other connected device
  // can clear its unread badge for this session. Broadcast on the global
  // channel; the originating device ignores the echo.
  | { kind: "session-read"; id: string; at: string }
  | { kind: "session-retitling"; id: string; inflight: boolean }
  | { kind: "session-settings"; id: string; model: string | null; permissionMode: string | null }
  | {
      kind: "notification";
      id: string;
      cwd: string;
      title: string;
      body: string;
      uuid: string;
      timestamp: string;
      peer?: boolean;
      // Monotonic per-backend-process counter assigned at emit time. Lets
      // clients dedup across reconnects and replay missed notifications via
      // the WS subscribe param `notifSinceSeq`.
      seq: number;
      // Backend-only: jsonl path that emitted this. Frontend has no use for it
      // (and shouldn't depend on filesystem layout).
      sourcePath?: string;
    }
  | {
      // Sent in response to `subscribe global` when the client did NOT pass
      // notifSinceSeq (first ever connect). Tells the client what seq to
      // baseline from so future reconnects can ask for replays.
      kind: "notif-baseline";
      seq: number;
    };
