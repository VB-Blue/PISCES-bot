import { t, useLocale } from './i18n'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { useDialog } from './useDialog'

export type Command = { id: string; label: string; hint?: string; group: string; icon?: ReactNode; keywords?: string; run: () => void }

// Ctrl+K: jump anywhere, start things, switch service, without leaving the keyboard.
export function CommandPalette({ commands, close, initial = '' }: { commands: Command[]; close: () => void; initial?: string }) {
  const locale = useLocale()
  const [query, setQuery] = useState(initial)
  const [index, setIndex] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  useDialog(dialog, true, close, '.palette-input input')
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return commands
    return commands.filter(command => { const hay = (t(command.label) + ' ' + command.label + ' ' + t(command.hint) + ' ' + (command.keywords || '') + ' ' + t(command.group)).toLowerCase(); return words.every(word => hay.includes(word)) })
  }, [commands, query, locale])
  useEffect(() => setIndex(0), [query])
  useEffect(() => { list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' }) }, [index])
  const run = (command?: Command) => { if (!command) return; close(); command.run() }
  let lastGroup = ''
  return <div className="palette-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close() }}>
    <div ref={dialog} className="palette" role="dialog" aria-modal="true" aria-label={t("命令面板")} tabIndex={-1}>
      <div className="palette-input"><MagnifyingGlass size={17} />
        <input ref={input} role="combobox" aria-expanded="true" aria-autocomplete="list" value={query} placeholder={t("搜索页面、对话和操作…")} aria-label={t("搜索命令")} aria-controls="command-results" aria-activedescendant={shown[index] ? 'command-' + shown[index].id : undefined} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(value => Math.max(0, Math.min(shown.length - 1, value + 1))) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(value => Math.max(0, value - 1)) }
            else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); run(shown[index]) }
            else if (event.key === 'Escape') { event.preventDefault(); close() }
          }} />
        <kbd>Esc</kbd>
      </div>
      <ul ref={list} id="command-results" role="listbox">
        {shown.length === 0 && <li className="palette-empty">{t("没有匹配的操作")}</li>}
        {shown.map((command, position) => {
          const header = command.group !== lastGroup ? <li className="palette-group" key={'g' + command.group + position} role="presentation">{t(command.group)}</li> : null
          lastGroup = command.group
          return <Fragment key={command.id}>{header}<li id={'command-' + command.id} role="option" aria-selected={position === index} className={position === index ? 'active' : ''} onMouseMove={() => setIndex(position)} onClick={() => run(command)}>
            <span className="palette-icon">{command.icon}</span><span className="palette-label">{t(command.label)}</span>{t(command.hint) && <small>{t(command.hint)}</small>}</li></Fragment>
        })}
      </ul>
      <div className="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd>{t("选择")}</span><span><kbd>Enter</kbd>{t("执行")}</span><span><kbd>Ctrl</kbd><kbd>K</kbd>{t("随时唤出")}</span></div>
    </div>
  </div>
}
