import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[10px] border border-transparent px-4 text-[14px] font-semibold tracking-[-0.01em] transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--focus-ring-color)] focus-visible:ring-offset-1 active:scale-[0.975] disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]',
        outline: 'border-[var(--border)] bg-[var(--bg)] text-[var(--fg)] hover:border-[var(--border-strong)] hover:bg-[var(--surface)]',
        ghost: 'text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--fg)]',
        subtle: 'bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent-soft-hover)]',
      },
      size: {
        default: 'h-11',
        sm: 'h-10 px-3 text-[13px]',
        icon: 'size-11 p-0',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
