import type { HTMLAttributes } from "react";
import { clsx } from "clsx";

interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return <div className={clsx("skeleton", className)} {...props} />;
}
