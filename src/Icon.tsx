import type { CSSProperties } from "react";

type IconName = "undo" | "reset" | "flip" | "left" | "right" | "plus";
const paths: Record<IconName, string> = {
  undo: "M9 5 4 10l5 5M4 10h9a6 6 0 0 1 0 12",
  reset: "M20 11a8 8 0 1 0-2 7M20 4v7h-7",
  flip: "M7 3v17m-4-4 4 4 4-4M17 21V4m-4 4 4-4 4 4",
  left: "m14 6-6 6 6 6",
  right: "m10 6 6 6-6 6",
  plus: "M12 5v14M5 12h14",
};
export function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
