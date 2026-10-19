import { useSyncExternalStore } from 'react'
import { translate, translateSystem, normalizeLocale, type Locale } from '../electron/i18n.cjs'
export type { Locale }
export const languages: { id: Locale; name: string }[] = [{ id: 'zh-CN', name: '简体中文' }, { id: 'en', name: 'English' }, { id: 'zh-TW', name: '繁體中文' }]
const initialLocale = () => { try { return normalizeLocale(window.memoryDesktop?.uiLocale?.() ?? localStorage.getItem('pisces-ui-locale')) } catch { return 'zh-CN' as const } }
let locale: Locale = initialLocale()
document.documentElement.lang = locale
const listeners = new Set<() => void>()
export const currentLocale = () => locale
export const subscribeLocale = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function setLocale(value: unknown) {
  const next = normalizeLocale(value)
  document.documentElement.lang = next
  try { localStorage.setItem('pisces-ui-locale', next) } catch { /* Desktop storage remains authoritative. */ }
  if (next === locale) return
  locale = next
  listeners.forEach(listener => listener())
}
export const useLocale = () => useSyncExternalStore(subscribeLocale, currentLocale, currentLocale)
export const t = (key: string | null | undefined, parameters?: Record<string,string | number | boolean | null | undefined>) => translate(locale,key,parameters)
export const systemText = (key: string | null | undefined) => translateSystem(locale,key)
export const formatNumber = (value: number) => new Intl.NumberFormat(locale).format(value)
export const formatDateTime = (value: string | number, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(new Date(value))
