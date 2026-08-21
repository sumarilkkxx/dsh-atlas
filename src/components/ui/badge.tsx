import * as React from 'react'
import { cn } from '../../lib/utils'

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex min-h-6 items-center gap-1 rounded-full border border-transparent bg-[var(--surface)] px-2 py-1 font-mono text-[11px] font-semibold leading-none text-[var(--muted)]', className)} {...props} />
}
