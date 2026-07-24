import { defineComponent, h, type PropType } from "vue";

type PathSpec = { d: string; fill?: string; stroke?: string };

function icon(name: string, paths: readonly PathSpec[]) {
  return defineComponent({
    name: `${name}Icon`,
    props: {
      size: { type: Number, default: 18 },
      strokeWidth: { type: Number, default: 1.8 },
      fill: { type: String as PropType<string>, default: "none" }
    },
    setup(props, { attrs }) {
      return () => h("svg", {
        ...attrs,
        width: props.size,
        height: props.size,
        viewBox: "0 0 24 24",
        fill: props.fill,
        stroke: "currentColor",
        "stroke-width": props.strokeWidth,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
        focusable: "false"
      }, paths.map((path) => h("path", {
        d: path.d,
        fill: path.fill,
        stroke: path.stroke
      })));
    }
  });
}

export const Search = icon("Search", [
  { d: "M10.8 4.5a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6Z" },
  { d: "m15.4 15.4 4.1 4.1" }
]);
export const Menu = icon("Menu", [
  { d: "M4 7h16M4 12h16M4 17h16" }
]);
export const Plus = icon("Plus", [{ d: "M12 5v14M5 12h14" }]);
export const Settings = icon("Settings", [
  { d: "M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" },
  { d: "M19 13.7c.1-.6.1-1.1 0-1.7l2-1.5-2-3.5-2.5 1a8 8 0 0 0-1.5-.9L14.7 4h-5.4L9 7.1c-.5.2-1 .5-1.5.9L5 7l-2 3.5L5 12a8 8 0 0 0 0 1.7l-2 1.5 2 3.5 2.5-1c.5.4 1 .7 1.5.9l.3 2.9h5.4l.3-2.9c.5-.2 1-.5 1.5-.9l2.5 1 2-3.5-2-1.5Z" }
]);
export const X = icon("X", [{ d: "m6 6 12 12M18 6 6 18" }]);
export const ChevronDown = icon("ChevronDown", [{ d: "m7 9.5 5 5 5-5" }]);
export const ChevronRight = icon("ChevronRight", [{ d: "m9.5 7 5 5-5 5" }]);
export const ArrowLeft = icon("ArrowLeft", [{ d: "m10 5-7 7 7 7M3 12h18" }]);
export const RefreshCw = icon("Refresh", [
  { d: "M20 7v5h-5" },
  { d: "M4 17v-5h5" },
  { d: "M6.1 8.2A7 7 0 0 1 18.7 7L20 12M4 12l1.3 5a7 7 0 0 0 12.6-1.2" }
]);
export const Pencil = icon("Pencil", [
  { d: "m4 20 4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16 4 20Z" },
  { d: "m14.8 6.4 2.8 2.8" }
]);
export const Pin = icon("Pin", [
  { d: "m14 4 6 6-3 1-3 4 1 2-2 2-8-8 2-2 2 1 4-3 1-3Z" },
  { d: "m9 15-5 5" }
]);
export const Trash2 = icon("Trash", [
  { d: "M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" }
]);
export const Archive = icon("Archive", [
  { d: "M4 7h16v13H4V7ZM3 4h18v3H3V4ZM9 11h6" }
]);
export const ArchiveRestore = icon("ArchiveRestore", [
  { d: "M4 7h16v13H4V7ZM3 4h18v3H3V4ZM12 16v-6M9 13l3-3 3 3" }
]);
export const CheckSquare = icon("CheckSquare", [
  { d: "M9 11.5 11.5 14 17 8.5M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z" }
]);
export const LoaderCircle = icon("Loader", [
  { d: "M21 12a9 9 0 1 1-6.2-8.6" }
]);
export const Paperclip = icon("Paperclip", [
  { d: "m9 17 7.5-7.5a3 3 0 0 0-4.2-4.2L4.8 12.8a5 5 0 0 0 7.1 7.1l7.4-7.4" }
]);
export const Send = icon("Send", [
  { d: "m3 4 18 8-18 8 4-8-4-8ZM7 12h14" }
]);
export const FileText = icon("FileText", [
  { d: "M6 3h8l4 4v14H6V3ZM14 3v5h5M9 12h6M9 16h6" }
]);
export const Check = icon("Check", [{ d: "m5 12 4 4 10-10" }]);
export const Square = icon("Square", [{ d: "M5 5h14v14H5z" }]);
export const Download = icon("Download", [
  { d: "M12 4v11M8 11l4 4 4-4M5 20h14" }
]);
export const MoreHorizontal = icon("More", [
  { d: "M6 12h.01M12 12h.01M18 12h.01", stroke: "currentColor" }
]);
export const Minimize2 = icon("Compact", [
  { d: "m8 3 1.5 1.5L12 7M16 3l-1.5 1.5L12 7M8 21l1.5-1.5L12 17M16 21l-1.5-1.5L12 17" }
]);
export const Octagon = icon("Stop", [
  { d: "m8 3-5 5v8l5 5h8l5-5V8l-5-5H8ZM9 9h6v6H9z" }
]);
export const Target = icon("Target", [
  { d: "M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 11a1 1 0 1 0 1 1M15 9l6-6M17 3h4v4" }
]);
export const CheckCircle2 = icon("CheckCircle", [
  { d: "M21 11.1V12a9 9 0 1 1-5.3-8.2M21 4l-10 10-3-3" }
]);
export const XCircle = icon("XCircle", [
  { d: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-3 6 6 6m0-6-6 6" }
]);
