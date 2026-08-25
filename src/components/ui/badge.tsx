import * as React from 'react'
import { cn } from '../../lib/utils'

export function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('inline-flex min-h-6 items-center gap-1 rounded-full border border-[var(--border-soft)] bg-[color:var(--surface-raised)] px-2.5 py-1 font-mono text-[10px] font-semibold leading-none tracking-[0.025em] text-[var(--muted)]', className)} {...props} />
}
