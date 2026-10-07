import * as React from "react"
import { cn } from "@/lib/utils"

/** A native <select> styled like Input: 36px, hairline, 8px radius, ink focus with a soft lime halo (index.css draws the chevron). */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-9 min-w-0 rounded-lg border border-input bg-card pl-3 text-sm text-foreground transition-[border-color,box-shadow] duration-150 outline-none hover:border-foreground/25 focus-visible:border-foreground focus-visible:ring-[3px] focus-visible:ring-brand/60 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className
      )}
      {...props}
    />
  )
}

export { NativeSelect }
