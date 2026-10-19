export type DesktopSelection = { id: string; title: string; process: string; selected_at: string; expires_seconds: number }
export type View = 'home' | 'work' | 'history' | 'abilities' | 'services' | 'core' | 'changes' | 'chat' | 'jobs' | 'connectors' | 'tasks' | 'learning' | 'memory' | 'goals' | 'control' | 'reminders' | 'operations' | 'usage' | 'browser'
export type NodeAssignment = { role?: string; inputs?: string[]; outputs?: string[]; execution?: { mode: 'serial' | 'parallel'; tools?: string[] }; execution_state?: { state: string; waiting_for?: string; role?: string; service?: string; model?: string; current_action?: { operation: string; label: string; status: string } } }
export type Mode = 'core' | 'live'
export type CoreReceipt = { turnId: string; session: string; subject: string; provider: string; reply: string; mode: string; evidence: unknown; factualVerification: 'unverified'; learned: false; desktop: Record<string, unknown> | null }
export type OwnerProfile = { user_id: string; revision: number; display_name: string; preferences: string; goals: string; boundaries: string; updated_at: string; source: string; confirmed_memory_facts?: string[] }
export type WorkReceipt = { id: string; operation: string; file_id: string | null; status: string; evidence: Record<string, unknown>; error: string | null }
export type AssistantWork = { id: string; session: string; goal: string; status: string; profile_revision: number; created_at: string; roles: string[]; calls: { id: string; role: string; model: string; status: string; total_tokens: number | null; note: string }[]; receipts: WorkReceipt[]; receipts_partial?: boolean; result: string; replay_of: string | null; cognition?: { revision: number; updated_at: string; request: string; turns: string[]; intent: unknown; plan: { id?: string; do: string; text?: string; expect?: string; status?: string; depends_on?: string[]; runtime_status?: string; verification?: { passed?: boolean; unmet?: string[]; reason?: string } }[]; verification: { source?: string; result?: unknown }; active_turn: string | null } | null }
export type UserUnderstanding = { key: string; value: string; quote: string; event_id: string; revision: number; status: 'candidate' | 'confirmed'; source: string; previous_values: { value: string; quote: string; revision: number }[]; pending_update?: { value: string; quote: string } | null }
export type PersistentTask = { id:string; title:string; notes:string; sessionId?:string; status:'active'|'paused'|'done'; createdAt:string; updatedAt:string }
export type LearnedMethod = { id: string; name: string; status: string; steps: string[]; independent_inputs: string[]; replay_sources: string[]; failures: number }
export type AssistantState = { profile: OwnerProfile; works: AssistantWork[]; methods: LearnedMethod[]; continuity?: { schema: number; facts: UserUnderstanding[] }; desktop_methods?: { routine_id: string; verified_successes: number; failure_count: number; quarantined: boolean; steps: { label: string; role: string }[] }[]; limits: { model_calls: number; tool_steps: number; file_bytes: number } }
export type ServiceSelection = { id: string; name: string; model: string; reason: string }
export type ChatResult = { requirementsCheck?: RequirementsCheck; service?: ServiceSelection; text: string; usage: { total_tokens?: number } | null; model: string; source: 'ai' | 'core'; core: CoreReceipt | null; work?: AssistantWork; notice?: string; steps?: { label: string; ok: boolean; error?: string }[]; plan?: PlanItem[] | null; subject?: { route: string; passed: boolean | null; localUnderstanding: boolean; skill: string | null; modelCalls: number | null } }
export type CoreSession = { session: string; user_id: string; latest_message_preview: string; latest_message_at: string; message_count: number }
export type Message = { requirementsCheck?: RequirementsCheck; service?: ServiceSelection; id: string; role: 'user' | 'assistant'; content: string; coreWorkId?: string; taskEvidence?: { workId: string; revision: number; receipts: WorkReceipt[] }; subject?: { route: string; passed: boolean | null; localUnderstanding: boolean; skill: string | null; modelCalls: number | null }; images?: string[]; error?: boolean; usage?: number; sample?: 'archive'; source?: 'ai' | 'core'; core?: CoreReceipt; warning?: string; raw?: { text: string; attachments: Attachment[] }; artifacts?: import('./PreviewPane').Preview[]; steps?: ToolStep[]; plan?: PlanItem[]; memoryUsed?: { id: string; text: string; kind: string }[]; playbooksUsed?: { id: string; title: string }[]; learned?: LearnedItem[]; vote?: 'up' | 'down' }
export type PlanItem = NodeAssignment & { text: string; status: 'pending' | 'doing' | 'done' | 'blocked'; id?: string; depends_on?: string[]; expect?: string; do?: string; runtime_status?: string; verification?: { passed?: boolean; unmet?: string[]; reason?: string } }
export type ToolStep = { label: string; status: 'running' | 'ok' | 'failed'; error?: string; file?: string }
export type SkillStep = { op: string; target?: unknown; window?: string; text?: string; keys?: string }
export type Skill = { id: string; title: string; trigger: string; app: string; params: { name: string; description: string; example: string }[]; steps: SkillStep[]; uses: number; successes: number; failures: number; lastError: string; createdAt: string; lastUsed?: string }
export type SubjectTask = { id: string; request: string; status: 'running' | 'done' | 'unverified' | 'interrupted'; route: string; intent: { goal: string; kind: string; done_criteria: { check: string; target?: string; value?: string }[] }; verification: { passed: boolean; unmet: string[] } | null; createdAt: string }
export type SubjectState = { authority?: 'canonical_core' | 'desktop_fallback'; autonomy: { tasks: number; passed: number; localUnderstanding: number; skillRuns: number; modelCalls: number; handledLocally: number }; tasks: SubjectTask[] }
export type LearnedItem = { type: 'memory' | 'playbook' | 'profile' | 'skill' | 'requirement'; id: string; kind?: string; text?: string; title?: string }
export type RequirementInput = { id?: string; revision?: number; text: string; domain: 'writing' | 'all'; scope?: string; enabled?: boolean; check?: { type: 'semantic' | 'contains' | 'not_contains' | 'min_length' | 'max_length'; value?: string | number } }
export type DurableRequirement = RequirementInput & { id: string; revision: number; scope: string; enabled: boolean; source: string; updatedAt: string; check: NonNullable<RequirementInput['check']>; history: { revision: number; text: string; changedAt: string }[] }
export type RequirementsCheck = { signature: string; checkedAt: string; passed: boolean; recordPath?: string; checks: { id: string; revision: number; text: string; status: 'passed' | 'failed' | 'unknown'; source?: string; reason: string; evidence?: string }[] }
export type MemoryItem = { id: string; kind: 'preference' | 'fact' | 'habit' | 'goal' | 'lesson'; text: string; pinned: boolean; source: 'user' | 'ai' | 'auto' | 'feedback'; createdAt: string; updatedAt: string; hits: number }
export type Playbook = { id: string; title: string; trigger: string; steps: string[]; source: string; score: number; uses: number; createdAt: string; updatedAt: string }
export type MemoryCoreLink = { linked: boolean; online: boolean; revision: number; pending: number; migrated: boolean; error: string; at: string }
export type MemoryStats = { memories: number; playbooks: number; turns: number; pinned: number; lessons: number; core?: MemoryCoreLink }
export type ToolAuditEntry = { ts: string; tool: string; summary: string; ok: boolean; error?: string; denied?: boolean }
export type Grant = { key: string; label: string; added: string }
export type Persona = { name: string; avatar: string; color: string; style: 'balanced' | 'concise' | 'warm' | 'professional' | 'playful' | 'custom'; custom: string }
export type Prefs = { persona: Persona; background: boolean; grants: Grant[]; maxTokens: number; control: boolean; delegate: boolean; subagentModel: string; web: boolean; files: boolean; commands: boolean; apps: boolean; autoLearn: boolean; closeToTray: boolean; openAtLogin: boolean; roots: string[]; defaultRoots?: string[] }
export type ToolApproval = { requestId?: string; sessionId?: string; approvalId: string; kind: 'tool'; title: string; lines: string[]; risk: 'low' | 'medium' | 'high'; allowSession: boolean; allowAlways?: boolean; grantLabel?: string; sessionScope?: 'conversation' }
export type HistoryHit = { ts: string; session: string; user: string; assistant: string }
export type Session = { draft?: string; profile?: string; id: string; title: string; updated: string; mode: Mode; messages: Message[] }
export type Trace = { id: string; sessionId: string; title: string; time: string; source: 'ai' | 'core' | 'demo'; status: 'recorded' | 'pending' | 'verified'; detail: string }
export type ConnectionSettings = { endpoint: string; model: string; coreUrl: string; hasApiKey: boolean; hasCoreToken: boolean }
export type Strength = 'strong' | 'fast' | 'cheap' | 'vision' | 'code' | 'long'
export type AgentRole = 'researcher' | 'coder' | 'operator' | 'writer' | 'reviewer' | 'planner' | 'verifier' | 'learner'
export type ProviderProfile = { id: string; name: string; endpoint: string; model: string; hasApiKey: boolean; strengths: Strength[]; note: string; maxConcurrent: number; noFailover: boolean }
export type ProviderStore = { profiles: ProviderProfile[]; defaultId: string; routes: Partial<Record<AgentRole, string>>; failover: boolean }
export type ProviderDraft = Omit<ProviderProfile, 'hasApiKey'> & { hasApiKey: boolean; apiKey?: string; clearApiKey?: boolean }
export type JobStatus = 'scheduled' | 'queued' | 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'unverified' | 'cancelled' | 'interrupted'
export type JobLog = { ts: string; kind: 'system' | 'user' | 'agent' | 'step'; text: string; ok?: boolean; error?: string }
export type UsageRecord = { id: string; scopeId: string; scopeLabel?: string; runId: string; day: string; role: string; model: string; providerId: string; status: string; startedAt: string; finishedAt: string | null; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; reservedTokens: number; chargedTokens: number; cachedTokens: number | null; reasoningTokens: number | null }
export type UsageSummary = { day: string; timeZone: string; policy: { dailyTokenLimit: number; timeZone: string }; scopeId: string; calls: number; reportedTokens: number; estimatedTokens: number; reservedTokens: number; accountedTokens: number; unknownCalls: number; inputTokens: number; outputTokens: number; records: UsageRecord[]; persistenceError: string }
export type LongGoalConfig = { id?: string; creationKey?: string; revision?: number; title?: string; objective: string; criteria?: string; constraints?: string; profile?: string; watchPaths?: string[]; minIntervalMinutes: number; maxIntervalMinutes: number; dailyTokenLimit: number; runTokenLimit: number }
export type LongGoal = LongGoalConfig & { id: string; title: string; revision: number; generation: number; status: 'active' | 'paused' | 'reviewing' | 'attention' | 'budget' | 'stopped'; cycle: number; jobId: string | null; updatedAt: string; createdAt: string; nextRunAt: number | null; nextAction: string; lastResult: string; lastRunAt: string | null; notice: string; history: { id: string; cycle: number; jobId: string; time: string; summary: string; result: string }[]; usage: UsageSummary; persistenceError: string }
export type JobApproval = { id: string; title: string; lines: string[]; risk: 'low' | 'medium' | 'high'; allowSession: boolean; allowAlways: boolean; grantLabel: string; nodeId?: string; nodeLeaseId?: string }
export type Job = { acceptance?: { requirementsCheck?: RequirementsCheck }; retryableFailure?: boolean; errorCode?: string; failure?: { code?: string; causeCode?: string; endpointHost?: string; phase?: string } | null; id: string; title: string; goal: string; status: JobStatus; createdAt: string; updatedAt: string; startedAt: string | null; finishedAt: string | null; runAt: number | null; repeat: 'hourly' | 'daily' | 'weekly' | null; profile: string; session: string; source: string; runs: number; result: string; error: string; approval: JobApproval | null; steps: number; log: JobLog[]; notes?: string; plan?: PlanItem[]; workId?: string | null; workRevision?: number | null; workStatus?: string; runId?: string | null; runVersion?: number; checkpointAt?: string | null; artifacts?: unknown[]; persistenceError?: string; currentAction?: { operation: string; label: string; startedAt: string; status: 'running' | 'done' | 'failed' | 'needs_recheck' | 'unknown'; finishedAt?: string; error?: string } | null }
export type Checkpoint = { id: string; path: string; action: 'create' | 'overwrite' | 'edit'; by: string; summary: string; ts: string; existed: boolean; status: 'active' | 'reverted' }
export type ConnectorTool = { name: string; description: string; kind: 'read' | 'write' | 'destructive'; policy: 'allow' | 'ask' | 'deny' }
export type Connector = { id: string; name: string; command: string; args: string[]; envKeys: string[]; enabled: boolean; access: 'read' | 'ask' | 'auto'; overrides: Record<string, 'allow' | 'ask' | 'deny'>; status: 'stopped' | 'starting' | 'ready' | 'error'; error: string; tools: ConnectorTool[] }
export type ConnectorDraft = { id?: string; name: string; command: string; args: string[]; enabled: boolean; access: Connector['access']; overrides: Connector['overrides']; env?: Record<string, string>; clearEnv?: string[] }
export type Attachment = { name: string; size: number; path?: string; isImage?: boolean; dataUrl?: string; kind?: string; truncated?: boolean }
export type Workspace = { workbench?: import('./workbenchState').WorkbenchState; tasks?: PersistentTask[]; appearanceVersion?: 2 | 3; version: 1; sessions: Session[]; traces: Trace[]; observe: boolean; theme: 'light' | 'dark'; goals: { id: string; title: string; done: boolean }[]; approval: 'pending' | 'approved' | 'denied'; memoryHidden: string[] }

export type Reminder = {
  id: string
  title: string
  content: string
  triggerAt: number
  targetDateStr: string
  createdAt: string
  session: string
  status: 'pending' | 'fired' | 'cancelled'
  firedAt?: string
  repeat?: 'daily' | 'weekly'
  late?: boolean
}

export type ApprovalClosed = { approvalId: string; closed: true }
export type DesktopActionApproval = { requestId?: string; sessionId?: string;
  approvalId: string
  workId: string
  operation: string
  proposal: Record<string, unknown>
  reason: string
  windowTitle?: string
}

declare global {
  interface Window {
    memoryDesktop?: {
      platform: string
      uiLocale(): import('./i18n').Locale
      saveUiLocale(value: import('./i18n').Locale): Promise<import('./i18n').Locale>
      settings(): Promise<ConnectionSettings>
      saveSettings(value: Partial<ConnectionSettings> & { apiKey?: string; coreToken?: string; clearApiKey?: boolean; clearCoreToken?: boolean }): Promise<ConnectionSettings>
      coreStatus(): Promise<{ ok: boolean; data: unknown }>
      startCore(): Promise<{ ok: boolean; data: unknown; reused?: boolean }>
      coreSessions(): Promise<{ ok: boolean; items: CoreSession[] }>
      coreHistory(session: string): Promise<{ ok: boolean; items: { record_id: string; role: 'user' | 'assistant'; content: string; created_at: string }[] }>
      learningState(): Promise<unknown>
      selectDesktop(): Promise<DesktopSelection>
      onToolReceipt(callback: (value: { id: string; phase: string; operation: string; label?: string; ok?: boolean; error?: string; file?: string; workId?: string; revision?: number; receipt?: WorkReceipt }) => void): () => void
      assistantState(): Promise<AssistantState>
      workDetail(id: string): Promise<AssistantWork | null>
      saveProfile(value: OwnerProfile): Promise<{ profile: OwnerProfile }>
      editUserFact(value: { key: string; revision: number; value: string | null }): Promise<unknown>
      replayMethod(value: { session: string; methodId: string; files: string[] }): Promise<{ work: AssistantWork }>
      exportProfile(): Promise<{ saved: boolean; path?: string }>
      assistantChat(value: { id: string; session: string; profile?: string; messages: { role: 'user' | 'assistant'; content: string; images?: string[] }[]; files?: string[]; multiAgent?: boolean; desktopTarget?: string; desktopConsent?: boolean }): Promise<ChatResult>
      desktopTask(value: { id: string; session: string; instruction: string; execute: boolean }): Promise<CoreReceipt>
      onCoreReceipt(callback: (value: { id: string; receipt: CoreReceipt }) => void): () => void
      controlLog(): Promise<{ ok: boolean; data: unknown }>
      chat(value: { id: string; session?: string; profile?: string; messages: { role: 'user' | 'assistant'; content: string; images?: string[] }[]; files?: string[]; multiAgent?: boolean; desktopTarget?: string; desktopConsent?: boolean }): Promise<ChatResult>
      cancelChat(id: string): Promise<void>
      onChatDelta(callback: (value: { id: string; text: string; reset?: boolean }) => void): () => void
      pickFiles(): Promise<Attachment[]>
      importAttachment(value: { name: string; bytes: Uint8Array }): Promise<Attachment>
      previewOpen(url: string): Promise<{ url: string }>
      previewBounds(value: { x:number; y:number; w:number; h:number; visible:boolean }): Promise<void>
      previewClose(): Promise<void>
      browserState(): Promise<import('./BrowserPage').BrowserState>
      browserTabs(): Promise<import('./BrowserPage').BrowserState>
      browserOpen(value: { url: string; mode?: string; connectionId?: string }): Promise<import('./BrowserPage').BrowserObservation>
      browserConnect(value: { endpoint: string }): Promise<unknown>
      browserAction(value: Record<string, unknown>): Promise<import('./BrowserPage').BrowserObservation & { closed?: string; shown?: boolean }>
      browserFrame(id: string): Promise<{ tabId: string; image: string; url: string; documentId: string; viewport: { width: number; height: number } }>
      browserViewport(id: string, size: { width: number; height: number }): Promise<unknown>
      browserSnapshot(id: string): Promise<import('./BrowserPage').BrowserObservation>
      browserRevealDownload(id: string): Promise<unknown>
      onBrowserUpdate(callback: (value: import('./BrowserPage').BrowserState) => void): () => void
      onPreviewState(callback: (value:{ url?:string; error?:string; loading?:boolean })=>void):()=>void
      openArtifact(value: { workId:string; receiptId:string; format:string }): Promise<{note:string}>
      openFile(file: string): Promise<void>
      revealFile(file: string): Promise<void>
      addDroppedFiles(files: FileList | File[]): Promise<Attachment[]>
      exportWorkspace(value: string): Promise<{ saved: boolean; path?: string }>
      window(action: 'minimize' | 'maximize' | 'close' | 'quit'): Promise<void>
      reminders(): Promise<Reminder[]>
      createReminder(value: { title?: string; content: string; delaySeconds?: number; targetTime?: string; session?: string; repeat?: 'daily' | 'weekly' }): Promise<Reminder>
      cancelReminder(id: string): Promise<boolean>
      onReminderFired(callback: (reminder: Reminder) => void): () => void
      onReminderClicked(callback: (reminder: Reminder) => void): () => void
      onDesktopApproval(callback: (approval: DesktopActionApproval | ToolApproval | ApprovalClosed) => void): () => void
      resolveDesktopApproval(value: { approvalId: string; approved?: boolean; decision?: 'once' | 'session' | 'always' | 'deny' }): Promise<void>
      deleteReminder(id: string): Promise<boolean>
      subjectState(): Promise<SubjectState>
      memory: {
        requirements(): Promise<DurableRequirement[]>
        saveRequirements(rules: RequirementInput[]): Promise<DurableRequirement[]>
        list(): Promise<{ memories: MemoryItem[]; playbooks: Playbook[]; stats: MemoryStats }>
        add(value: { kind: MemoryItem['kind']; text: string; pinned?: boolean }): Promise<{ memory: MemoryItem; duplicate: boolean }>
        update(id: string, patch: Partial<Pick<MemoryItem, 'text' | 'kind' | 'pinned'>>): Promise<MemoryItem>
        remove(id: string): Promise<boolean>
        updatePlaybook(id: string, patch: Partial<Pick<Playbook, 'title' | 'trigger' | 'steps'>>): Promise<Playbook>
        removePlaybook(id: string): Promise<boolean>
        skills(): Promise<Skill[]>
        removeSkill(id: string): Promise<boolean>
        feedback(value: { vote: 'up' | 'down'; note?: string; question?: string; playbooks?: string[]; memories?: string[] }): Promise<{ lesson: MemoryItem | null }>
        searchHistory(query: string): Promise<HistoryHit[]>
        profile(): Promise<{ profile: string }>
        saveProfile(text: string): Promise<{ profile: string; changed: boolean }>
        undoProfile(): Promise<{ profile: string }>
      }
      onPlan(callback: (value: { id: string; plan: PlanItem[] }) => void): () => void
      toolAudit(): Promise<ToolAuditEntry[]>
      prefs(): Promise<Prefs>
      savePrefs(value: Partial<Prefs>): Promise<Prefs>
      pickFolder(): Promise<string | null>
      loadWorkspace(): string | null
      saveWorkspace(json: string): void
      saveWorkspaceSync(json: string): boolean | null
      jobs(): Promise<Job[]>
      usageSummary(scopeId?: string): Promise<UsageSummary>
      saveUsagePolicy(value: { dailyTokenLimit: number }): Promise<UsageSummary>
      longGoals(): Promise<LongGoal[]>
      saveLongGoal(value: LongGoalConfig): Promise<LongGoal>
      longGoalAction(value: { id: string; action: 'pause' | 'resume' | 'run' | 'stop' }): Promise<LongGoal>
      onUsage(callback: (value: UsageSummary) => void): () => void
      onLongGoal(callback: (value: LongGoal | { error: string }) => void): () => void
      createJob(value: { title?: string; goal: string; runAt?: number | null; repeat?: Job['repeat']; profile?: string }): Promise<Job>
      jobAction(value: { id: string; action: 'pause' | 'resume' | 'cancel' | 'start' | 'remove' | 'approve'; decision?: 'once' | 'session' | 'always' | 'deny'; approvalId?: string }): Promise<Job | null>
      runtimeStatus(): Promise<{online:boolean;ready:boolean;stopped?:boolean;stopping?:boolean;mode?:string;pid?:number;version?:string;counts?:{running:number;waiting:number;scheduled:number};error?:string}>
      onCoreConnection(callback: (state: {online:boolean;error?:string;at:number}) => void): () => void
      onRuntimeState(callback: (state: Awaited<ReturnType<NonNullable<Window['memoryDesktop']>['runtimeStatus']>>) => void): () => void
      startRuntime(): Promise<unknown>
      stopRuntime(): Promise<unknown>
      openWorkFile(value: { workId: string; receiptId: string; path: string; reveal?: boolean }): Promise<{ opened: boolean }>
      instructJob(value: { id: string; text: string }): Promise<Job>
      onJob(callback: (value: Job | { id: string; removed: true }) => void): () => void
      onJobFocus(callback: (id: string) => void): () => void
      checkpoints(): Promise<Checkpoint[]>
      revertCheckpoint(id: string): Promise<{ id: string; path: string; restored: string }>
      connectors(): Promise<Connector[]>
      saveConnectors(list: ConnectorDraft[]): Promise<Connector[]>
      connectConnector(id: string): Promise<Connector[]>
      disconnectConnector(id: string): Promise<Connector[]>
      onConnectors(callback: (value: Connector[]) => void): () => void
      providers(): Promise<ProviderStore>
      saveProviders(value: { profiles: ProviderDraft[]; defaultId: string; routes: ProviderStore['routes']; failover: boolean }): Promise<ProviderStore>
      testAI(value: { endpoint?: string; model?: string; apiKey?: string; profileId?: string }): Promise<{ ok: boolean; models: string[]; modelChecked: boolean; listError?: string }>
      listModels(value: { endpoint?: string; apiKey?: string; profileId?: string }): Promise<{ models: string[]; url: string }>
      onMemoryUsed(callback: (value: { id: string; memories: { id: string; text: string; kind: string }[]; playbooks: { id: string; title: string }[] }) => void): () => void
      onMemoryLearned(callback: (value: { id: string; items: LearnedItem[] }) => void): () => void
    }
  }
}
