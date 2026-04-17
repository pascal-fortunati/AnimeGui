import type { ButtonHTMLAttributes } from "react"
import { clsx } from "clsx"

type Variant = "default" | "secondary" | "danger"

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
}

export function Button({ className, variant = "default", ...props }: ButtonProps) {
  return (
    <button
      className={clsx(
        "btn",
        variant === "secondary" && "btn-secondary",
        variant === "danger" && "btn-danger",
        className
      )}
      {...props}
    />
  )
}
