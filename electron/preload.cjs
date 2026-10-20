const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('memoryDesktop', {
  platform: process.platform,
  runtimeStatus: () => ipcRenderer.invoke('runtime:status'),
  startRuntime: () => ipcRenderer.invoke('runtime:start'),
  stopRuntime: () => ipcRenderer.invoke('runtime:stop'),
  onRuntimeState: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('runtime:state', listener);
    return () => ipcRenderer.removeListener('runtime:state', listener);
  },
  settings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: value => ipcRenderer.invoke('settings:save', value),
  coreStatus: () => ipcRenderer.invoke('core:status'),
  onCoreConnection: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('core:connection', listener);
    return () => ipcRenderer.removeListener('core:connection', listener);
  },
  startCore: () => ipcRenderer.invoke('core:start'),
  coreSessions: () => ipcRenderer.invoke('core:sessions'),
  coreHistory: session => ipcRenderer.invoke('core:history', session),
  learningState: () => ipcRenderer.invoke('core:learning-state'),
  assistantState: () => ipcRenderer.invoke('core:assistant-state'),
  workDetail: id => ipcRenderer.invoke('core:work-detail', id),
  selectDesktop: () => ipcRenderer.invoke('core:select-desktop'),
  onToolReceipt: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('assistant:tool', listener);
    return () => ipcRenderer.removeListener('assistant:tool', listener);
  },
  saveProfile: value => ipcRenderer.invoke('core:profile-save', value),
  editUserFact: value => ipcRenderer.invoke('core:fact-edit', value),
  exportProfile: () => ipcRenderer.invoke('core:profile-export'),
  replayMethod: value => ipcRenderer.invoke('core:method-replay', value),
  assistantChat: value => ipcRenderer.invoke('assistant:chat', value),
  desktopTask: value => ipcRenderer.invoke('core:desktop', value),
  onCoreReceipt: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('core:receipt', listener);
    return () => ipcRenderer.removeListener('core:receipt', listener);
  },
  controlLog: () => ipcRenderer.invoke('core:control-log'),
  chat: value => ipcRenderer.invoke('ai:chat', value),
  cancelChat: id => ipcRenderer.invoke('ai:cancel', id),
  onChatDelta: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('ai:delta', listener);
    return () => ipcRenderer.removeListener('ai:delta', listener);
  },
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  importAttachment: value => ipcRenderer.invoke('files:import', value),
  previewOpen: url => ipcRenderer.invoke('preview:open', url),
  previewBounds: value => ipcRenderer.invoke('preview:bounds', value),
  previewClose: () => ipcRenderer.invoke('preview:close'),
  browserState: () => ipcRenderer.invoke('browser:state'),
  browserTabs: () => ipcRenderer.invoke('browser:list'),
  browserOpen: args => ipcRenderer.invoke('browser:open', args),
  browserConnect: args => ipcRenderer.invoke('browser:connect', args),
  browserAction: args => ipcRenderer.invoke('browser:action', args),
  browserFrame: id => ipcRenderer.invoke('browser:frame', id),
  browserViewport: (id, size) => ipcRenderer.invoke('browser:viewport', id, size),
  browserSnapshot: id => ipcRenderer.invoke('browser:snapshot', id),
  browserRevealDownload: id => ipcRenderer.invoke('browser:reveal-download', id),
  onBrowserUpdate: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('browser:update', listener); return () => ipcRenderer.removeListener('browser:update', listener); },
  openArtifact: value => ipcRenderer.invoke('artifact:open', value),
  openWorkFile: value => ipcRenderer.invoke('work:file-open', value),
  openFile: file => ipcRenderer.invoke('file:open', file),
  revealFile: file => ipcRenderer.invoke('file:reveal', file),
  onPreviewState: callback => {
    const listener=(_event,value)=>callback(value);ipcRenderer.on('preview:state',listener);
    return ()=>ipcRenderer.removeListener('preview:state',listener);
  },
  // Electron removed File.path; dropped files must be resolved through webUtils.
  addDroppedFiles: files => ipcRenderer.invoke('files:register', Array.from(files).map(file => webUtils.getPathForFile(file)).filter(Boolean)),
  exportWorkspace: value => ipcRenderer.invoke('workspace:export', value),
  window: action => ipcRenderer.invoke('window:action', action),
  reminders: () => ipcRenderer.invoke('reminder:list'),
  createReminder: value => ipcRenderer.invoke('reminder:create', value),
  cancelReminder: id => ipcRenderer.invoke('reminder:cancel', id),
  deleteReminder: id => ipcRenderer.invoke('reminder:delete', id),
  onReminderFired: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('reminder:fired', listener);
    return () => ipcRenderer.removeListener('reminder:fired', listener);
  },
  onReminderClicked: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('reminder:clicked', listener);
    return () => ipcRenderer.removeListener('reminder:clicked', listener);
  },
  onDesktopApproval: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('desktop:approval_request', listener);
    return () => ipcRenderer.removeListener('desktop:approval_request', listener);
  },
  resolveDesktopApproval: value => ipcRenderer.invoke('desktop:approval_resolve', value),
  subjectState: () => ipcRenderer.invoke('subject:state'),
  cognitionState: () => ipcRenderer.invoke('cognition:state'),
  memory: {
    requirements: () => ipcRenderer.invoke('requirements:list'),
    saveRequirements: rules => ipcRenderer.invoke('requirements:save', { rules }),
    list: () => ipcRenderer.invoke('memory:list'),
    add: value => ipcRenderer.invoke('memory:add', value),
    update: (id, patch) => ipcRenderer.invoke('memory:update', id, patch),
    remove: id => ipcRenderer.invoke('memory:delete', id),
    updatePlaybook: (id, patch) => ipcRenderer.invoke('playbook:update', id, patch),
    removePlaybook: id => ipcRenderer.invoke('playbook:delete', id),
    skills: () => ipcRenderer.invoke('skill:list'),
    removeSkill: id => ipcRenderer.invoke('skill:delete', id),
    feedback: value => ipcRenderer.invoke('memory:feedback', value),
    searchHistory: query => ipcRenderer.invoke('history:search', query),
    profile: () => ipcRenderer.invoke('profile:get'),
    saveProfile: text => ipcRenderer.invoke('profile:set', text),
    undoProfile: () => ipcRenderer.invoke('profile:undo'),
  },
  onPlan: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('assistant:plan', listener);
    return () => ipcRenderer.removeListener('assistant:plan', listener);
  },
  toolAudit: () => ipcRenderer.invoke('tools:audit'),
  prefs: () => ipcRenderer.invoke('prefs:get'),
  uiLocale: () => ipcRenderer.sendSync('locale:get'),
  saveUiLocale: value => ipcRenderer.invoke('locale:set', value),
  savePrefs: value => ipcRenderer.invoke('prefs:save', value),
  pickFolder: () => ipcRenderer.invoke('prefs:add-root'),
  testAI: value => ipcRenderer.invoke('ai:test', value),
  listModels: value => ipcRenderer.invoke('ai:models', value),
  loadWorkspace: () => ipcRenderer.sendSync('workspace:load'),
  saveWorkspace: json => ipcRenderer.send('workspace:save', json),
  saveWorkspaceSync: json => ipcRenderer.sendSync('workspace:save-sync', json),
  jobs: () => ipcRenderer.invoke('jobs:list'),
  usageSummary: scopeId => ipcRenderer.invoke('usage:summary', scopeId),
  saveUsagePolicy: value => ipcRenderer.invoke('usage:policy', value),
  longGoals: () => ipcRenderer.invoke('goals:list'),
  saveLongGoal: value => ipcRenderer.invoke('goals:save', value),
  longGoalAction: value => ipcRenderer.invoke('goals:action', value),
  onUsage: callback => {
    const listener = (_event, value) => callback(value); ipcRenderer.on('usage:update', listener);
    return () => ipcRenderer.removeListener('usage:update', listener);
  },
  onLongGoal: callback => {
    const listener = (_event, value) => callback(value); ipcRenderer.on('goals:update', listener);
    return () => ipcRenderer.removeListener('goals:update', listener);
  },
  createJob: value => ipcRenderer.invoke('jobs:create', value),
  jobAction: value => ipcRenderer.invoke('jobs:action', value),
  instructJob: value => ipcRenderer.invoke('jobs:instruct', value),
  onJob: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('jobs:update', listener);
    return () => ipcRenderer.removeListener('jobs:update', listener);
  },
  onJobFocus: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('jobs:focus', listener);
    ipcRenderer.send('ui:ready');
    return () => ipcRenderer.removeListener('jobs:focus', listener);
  },
  checkpoints: () => ipcRenderer.invoke('checkpoints:list'),
  revertCheckpoint: id => ipcRenderer.invoke('checkpoints:revert', id),
  connectors: () => ipcRenderer.invoke('connectors:list'),
  saveConnectors: list => ipcRenderer.invoke('connectors:save', list),
  connectConnector: id => ipcRenderer.invoke('connectors:connect', id),
  disconnectConnector: id => ipcRenderer.invoke('connectors:disconnect', id),
  onConnectors: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('connectors:update', listener);
    return () => ipcRenderer.removeListener('connectors:update', listener);
  },
  providers: () => ipcRenderer.invoke('providers:get'),
  saveProviders: value => ipcRenderer.invoke('providers:save', value),
  onMemoryUsed: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('memory:used', listener);
    return () => ipcRenderer.removeListener('memory:used', listener);
  },
  onMemoryLearned: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('memory:learned', listener);
    return () => ipcRenderer.removeListener('memory:learned', listener);
  },
});
