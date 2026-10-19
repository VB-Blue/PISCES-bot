import { useEffect, useRef, type RefObject } from 'react'

const stack: HTMLElement[] = []
const inertOwners = new WeakMap<HTMLElement, { count: number; previous: boolean }>()
const focusable = 'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

// One lifecycle for modal surfaces: contain focus, suspend background interaction, restore the trigger.
export function useDialog(ref: RefObject<HTMLElement | null>, active: boolean, escape: () => void, initial = '[data-dialog-focus]') {
  const onEscape = useRef(escape)
  onEscape.current = escape
  useEffect(() => {
    const root = ref.current
    if (!active || !root) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const background = [...(root.closest('.app')?.children || [])].filter((element): element is HTMLElement => element instanceof HTMLElement && !element.contains(root))
    for (const element of background) {
      const owner = inertOwners.get(element) || { count: 0, previous: element.inert }
      owner.count++; inertOwners.set(element, owner); element.inert = true
    }
    stack.push(root)
    const items = () => [...root.querySelectorAll<HTMLElement>(focusable)].filter(element => element.getClientRects().length && !element.closest('[inert]'))
    const target = root.querySelector<HTMLElement>(initial) || items()[0] || root
    target.focus({ preventScroll: true })
    const key = (event: KeyboardEvent) => {
      if (stack.at(-1) !== root || event.defaultPrevented) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onEscape.current(); return }
      if (event.key !== 'Tab') return
      const list = items(), first = list[0], last = list.at(-1)
      if (!first) { event.preventDefault(); root.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement) || document.activeElement === target)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    root.addEventListener('keydown', key)
    return () => {
      root.removeEventListener('keydown', key)
      stack.splice(stack.indexOf(root), 1)
      for (const element of background) {
        const owner = inertOwners.get(element)
        if (owner && --owner.count === 0) { element.inert = owner.previous; inertOwners.delete(element) }
      }
      requestAnimationFrame(() => { if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true }) })
    }
  }, [active, ref, initial])
}
