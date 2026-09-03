export type ContextPressureTone = "notice" | "urgent" | "compacting";

export interface ContextPressureState {
  visible: boolean;
  tone: ContextPressureTone;
  remainingPercent: number | null;
  title: string;
  detail: string;
}

const WARNING_REMAINING_RATIO = 0.2;
const URGENT_REMAINING_RATIO = 0.1;

export function contextPressureState(
  tokens: number,
  limit: number | null,
  compacting: boolean,
): ContextPressureState {
  if (compacting) {
    return {
      visible: true,
      tone: "compacting",
      remainingPercent: null,
      title: "正在整理上下文…",
      detail: "回复可能短暂停顿，完成后会自动继续。",
    };
  }

  if (!Number.isFinite(tokens) || tokens < 0 || !Number.isFinite(limit) || !limit || limit <= 0) {
    return {
      visible: false,
      tone: "notice",
      remainingPercent: null,
      title: "",
      detail: "",
    };
  }

  const remainingRatio = Math.max(0, Math.min(1, 1 - tokens / limit));
  const remainingPercent = Math.ceil(remainingRatio * 100);
  if (remainingRatio > WARNING_REMAINING_RATIO) {
    return {
      visible: false,
      tone: "notice",
      remainingPercent,
      title: "",
      detail: "",
    };
  }

  if (remainingRatio <= URGENT_REMAINING_RATIO) {
    return {
      visible: true,
      tone: "urgent",
      remainingPercent,
      title: "即将整理上下文",
      detail: `上下文仅剩 ${remainingPercent}%；较早内容会自动压缩为摘要。`,
    };
  }

  return {
    visible: true,
    tone: "notice",
    remainingPercent,
    title: `上下文剩余 ${remainingPercent}%`,
    detail: "接近自动整理；较早内容会压缩为摘要。",
  };
}
