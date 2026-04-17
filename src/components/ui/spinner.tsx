import type { HTMLAttributes } from "react";

interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> { }

export function Spinner({ className, ...props }: SpinnerProps) {
    const classes = className ? `spinner ${className}` : "spinner";
    return <span className={classes} aria-label="loading" role="status" {...props} />;
}
