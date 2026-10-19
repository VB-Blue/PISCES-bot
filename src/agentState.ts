import { useCallback, useEffect, useRef, useState } from 'react'
import type { Checkpoint, Connector, Job } from './types'
import { cleanError } from './ui'

// Live list of background jobs: loaded once, then kept current by pushes from the main process.
export function useJobs(notify: (text: string) => void) {
  const [jobs, setJobs] = useState<Job[]>([])
  const [ready, setReady] = useState(!window.memoryDesktop)
  const commit = (value: Job) => setJobs(previous => {
    const old = previous.find(item => item.id === value.id)
    // An IPC reply may arrive after a newer progress push. Keep the latest saved task projection.
    if (old && ((old.runVersion || 0) > (value.runVersion || 0) || Date.parse(old.updatedAt) > Date.parse(value.updatedAt))) return previous
    return old ? previous.map(item => item.id === value.id ? value : item) : [value, ...previous]
  })
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  useEffect(() => {
    const api = window.memoryDesktop
    if (!api) return
    api.jobs().then(setJobs).catch(error => notifyRef.current(cleanError(error))).finally(() => setReady(true))
    return api.onJob(value => setJobs(previous => {
      if ('removed' in value) return previous.filter(item => item.id !== value.id)
      const next = previous.some(item => item.id === value.id) ? previous.map(item => item.id === value.id ? value : item) : [value, ...previous]
      return next
    }))
  }, [])
  const run = useCallback(async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    try { return await action() } catch (error) { notifyRef.current(cleanError(error)); return undefined }
  }, [])
  return {
    jobs,
    ready,
    create: async (value: Parameters<NonNullable<typeof window.memoryDesktop>['createJob']>[0]) => { const job = await run(() => window.memoryDesktop!.createJob(value)); if (job) commit(job); return job },
    act: (id: string, action: 'pause' | 'resume' | 'cancel' | 'start' | 'remove' | 'approve', decision?: 'once' | 'session' | 'always' | 'deny', approvalId?: string) => run(() => window.memoryDesktop!.jobAction({ id, action, decision, approvalId })),
    instruct: (id: string, text: string) => run(() => window.memoryDesktop!.instructJob({ id, text })),
  }
}

export function useConnectors(notify: (text: string) => void) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  useEffect(() => {
    const api = window.memoryDesktop
    if (!api) return
    api.connectors().then(setConnectors).catch(error => notifyRef.current(cleanError(error)))
    return api.onConnectors(setConnectors)
  }, [])
  return { connectors, setConnectors }
}

export function useCheckpoints(notify: (text: string) => void, refreshKey: unknown) {
  const [items, setItems] = useState<Checkpoint[]>([])
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  const reload = useCallback(() => { window.memoryDesktop?.checkpoints().then(setItems).catch(error => notifyRef.current(cleanError(error))) }, [])
  useEffect(reload, [reload, refreshKey])
  return { items, reload }
}
