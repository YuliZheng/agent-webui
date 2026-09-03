const FALLBACK_EMOJI_CHOICES: Array<[RegExp, string]> = [
  [/(?:bug|fix|error|crash|debug|修复|报错|错误|故障|排查)/u, "🛠️"],
  [/(?:search|research|find|lookup|搜索|查找|调研|研究)/u, "🔎"],
  [/(?:travel|flight|hotel|trip|旅行|旅游|航班|酒店|行程|交通)/u, "✈️"],
  [/(?:mail|email|inbox|邮件|邮箱)/u, "✉️"],
  [/(?:fitness|workout|training|protein|健身|训练|蛋白)/u, "💪"],
  [/(?:food|meal|restaurant|takeout|吃|餐厅|外卖|饮食)/u, "🍽️"],
  [/(?:image|design|ui|ux|视觉|图片|设计|界面)/u, "🎨"],
  [/(?:document|report|write|文章|文档|报告|写作)/u, "📝"],
  [/(?:stock|finance|money|budget|股票|金融|预算|价格)/u, "📈"],
  [/(?:code|api|frontend|backend|test|代码|前端|后端|测试)/u, "💻"],
];

const FLAG_EMOJI = /^\p{Regional_Indicator}{2}$/u;

export function fallbackSessionTitleEmoji(title: string): string {
  const value = title.toLocaleLowerCase();
  return FALLBACK_EMOJI_CHOICES.find(([pattern]) => pattern.test(value))?.[1] ?? "💬";
}

export function sessionTitleEmojiForDisplay(
  title: string | null | undefined,
  emoji: string | null | undefined,
  source: "auto" | "manual" | null | undefined,
): string | null {
  const saved = emoji?.trim();
  if (saved) return saved;
  const normalizedTitle = title?.trim();
  return source === "auto" && normalizedTitle
    ? fallbackSessionTitleEmoji(normalizedTitle)
    : null;
}

export function flagEmojiAssetKey(emoji: string): string | null {
  const normalized = emoji.trim();
  if (!FLAG_EMOJI.test(normalized)) return null;
  return [...normalized]
    .map(character => character.codePointAt(0)!.toString(16))
    .join("-");
}
