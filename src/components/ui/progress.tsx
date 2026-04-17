import * as ProgressPrimitive from "@radix-ui/react-progress";

interface ProgressProps {
    value: number;
    className?: string;
    indicatorClassName?: string;
}

export function Progress({ value, className, indicatorClassName }: ProgressProps) {
    const clampedValue = Math.max(0, Math.min(100, value));

    return (
        <ProgressPrimitive.Root className={`progress-root ${className ?? ""}`.trim()} value={clampedValue}>
            <ProgressPrimitive.Indicator
                className={`progress-indicator ${indicatorClassName ?? ""}`.trim()}
                style={{ transform: `translateX(-${100 - clampedValue}%)` }}
            />
        </ProgressPrimitive.Root>
    );
}
