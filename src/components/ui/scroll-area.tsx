import { forwardRef, type ComponentPropsWithoutRef } from "react"
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area"
import { clsx } from "clsx"

interface ScrollAreaProps extends ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> { }

export const ScrollArea = forwardRef<
  HTMLDivElement,
  ScrollAreaProps
>(({ className, children, ...props }, ref) => {
  return (
    <ScrollAreaPrimitive.Root
      ref={ref}
      className={clsx("scroll-area-root", className)}
      type="always"
      scrollHideDelay={0}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport className="scroll-area-viewport">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        className="scroll-area-scrollbar"
        orientation="vertical"
        forceMount
      >
        <ScrollAreaPrimitive.Thumb className="scroll-area-thumb" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner className="scroll-area-corner" />
    </ScrollAreaPrimitive.Root>
  )
})
