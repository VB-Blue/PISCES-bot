export type Locale = 'zh-CN' | 'en' | 'zh-TW'
export const locales: Locale[]
export const systemPrefixes: string[]
export function translateSystem(locale: Locale, key: string | null | undefined): string
export function normalizeLocale(value: unknown): Locale
export function translate(locale: Locale, key: string | null | undefined, parameters?: Record<string, string | number | boolean | null | undefined>): string
export const catalogs: Record<'en' | 'zh-TW', Record<string,string>>
