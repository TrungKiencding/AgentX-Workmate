import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('agentxDesktop', {
  getConnection: profile => ipcRenderer.invoke('agentx:connection', profile),
  revalidateConnection: () => ipcRenderer.invoke('agentx:connection:revalidate'),
  touchBackend: profile => ipcRenderer.invoke('agentx:backend:touch', profile),
  getGatewayWsUrl: profile => ipcRenderer.invoke('agentx:gateway:ws-url', profile),
  openSessionWindow: (sessionId, opts) => ipcRenderer.invoke('agentx:window:openSession', sessionId, opts),
  openWindow: () => ipcRenderer.invoke('agentx:window:openInstance'),
  claimAmbientCue: key => ipcRenderer.invoke('agentx:ambient:claim', key),
  wakeIndicator: {
    getState: () => ipcRenderer.invoke('agentx:wake-indicator:get'),
    setState: state => ipcRenderer.send('agentx:wake-indicator:set', state),
    onState: callback => {
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('agentx:wake-indicator:state', listener)

      return () => ipcRenderer.removeListener('agentx:wake-indicator:state', listener)
    }
  },
  petOverlay: {
    // Main renderer → main process: window lifecycle + drag. `request` is
    // `{ bounds, screen }`; resolves with the screen bounds it actually used.
    open: request => ipcRenderer.invoke('agentx:pet-overlay:open', request),
    close: () => ipcRenderer.invoke('agentx:pet-overlay:close'),
    setBounds: bounds => ipcRenderer.send('agentx:pet-overlay:set-bounds', bounds),
    setIgnoreMouse: ignore => ipcRenderer.send('agentx:pet-overlay:ignore-mouse', ignore),
    // Flip the overlay focusable (and focus it) while the composer needs keys.
    setFocusable: focusable => ipcRenderer.send('agentx:pet-overlay:set-focusable', focusable),
    // Main renderer → overlay (forwarded by main): push the latest pet state.
    pushState: payload => ipcRenderer.send('agentx:pet-overlay:state', payload),
    // Overlay → main renderer (forwarded by main): pop back in / composer submit.
    control: payload => ipcRenderer.send('agentx:pet-overlay:control', payload),
    // Overlay subscribes to state pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('agentx:pet-overlay:state', listener)

      return () => ipcRenderer.removeListener('agentx:pet-overlay:state', listener)
    },
    // Main renderer subscribes to overlay control messages.
    onControl: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('agentx:pet-overlay:control', listener)

      return () => ipcRenderer.removeListener('agentx:pet-overlay:control', listener)
    }
  },
  // Quick Entry: the global-hotkey mini composer window. Main owns the OS
  // shortcut + the persisted preference; the quick window only captures text
  // and hands it back, and the primary renderer submits it through the normal
  // prompt path.
  quickEntry: {
    getSettings: () => ipcRenderer.invoke('agentx:quick-entry:settings:get'),
    setSettings: patch => ipcRenderer.invoke('agentx:quick-entry:settings:set', patch),
    submit: payload => ipcRenderer.send('agentx:quick-entry:submit', payload),
    dismiss: () => ipcRenderer.send('agentx:quick-entry:dismiss'),
    // Primary renderer → main → quick window: gateway connection state + the
    // recent-session options the target picker offers. Main caches the latest
    // payload so a freshly spawned quick window starts from truth.
    pushState: payload => ipcRenderer.send('agentx:quick-entry:state', payload),
    // Quick window subscribes to those pushes.
    onState: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('agentx:quick-entry:state', listener)

      return () => ipcRenderer.removeListener('agentx:quick-entry:state', listener)
    },
    // Main → primary renderer: a submit captured by the quick window.
    onSubmit: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('agentx:quick-entry:submit', listener)

      return () => ipcRenderer.removeListener('agentx:quick-entry:submit', listener)
    },
    // Main → quick window: you were just summoned (reset draft + refocus).
    onShown: callback => {
      const listener = () => callback()
      ipcRenderer.on('agentx:quick-entry:shown', listener)

      return () => ipcRenderer.removeListener('agentx:quick-entry:shown', listener)
    }
  },
  getBootProgress: () => ipcRenderer.invoke('agentx:boot-progress:get'),
  getConnectionConfig: profile => ipcRenderer.invoke('agentx:connection-config:get', profile),
  saveConnectionConfig: payload => ipcRenderer.invoke('agentx:connection-config:save', payload),
  applyConnectionConfig: payload => ipcRenderer.invoke('agentx:connection-config:apply', payload),
  testConnectionConfig: payload => ipcRenderer.invoke('agentx:connection-config:test', payload),
  sshConfigHosts: () => ipcRenderer.invoke('agentx:ssh-config:hosts'),
  sshResolveHost: host => ipcRenderer.invoke('agentx:ssh-config:resolve', host),
  probeConnectionConfig: remoteUrl => ipcRenderer.invoke('agentx:connection-config:probe', remoteUrl),
  oauthLoginConnectionConfig: remoteUrl => ipcRenderer.invoke('agentx:connection-config:oauth-login', remoteUrl),
  oauthLogoutConnectionConfig: remoteUrl => ipcRenderer.invoke('agentx:connection-config:oauth-logout', remoteUrl),
  // AgentX Cloud: one portal login powers discovery + silent per-agent sign-in
  // (cloud-auto-discovery Phase 3).
  cloud: {
    status: () => ipcRenderer.invoke('agentx:cloud:status'),
    login: () => ipcRenderer.invoke('agentx:cloud:login'),
    logout: () => ipcRenderer.invoke('agentx:cloud:logout'),
    discover: org => ipcRenderer.invoke('agentx:cloud:discover', org),
    agentSignIn: dashboardUrl => ipcRenderer.invoke('agentx:cloud:agent-sign-in', dashboardUrl)
  },
  // Keycloak SSO for a gated LOCAL backend: the AgentX Workmate sign-in, using
  // the account the user already has in AgentX. `signIn` opens the system
  // browser and resolves once the loopback callback lands.
  keycloak: {
    status: profile => ipcRenderer.invoke('agentx:keycloak:status', profile),
    signIn: profile => ipcRenderer.invoke('agentx:keycloak:sign-in', profile),
    signOut: profile => ipcRenderer.invoke('agentx:keycloak:sign-out', profile)
  },
  // The signed-in account: which AgentX home this person owns on this machine,
  // and the state of the model key provisioned for them. There is no `set` —
  // the account is whoever signed in, never a renderer choice.
  account: {
    status: () => ipcRenderer.invoke('agentx:account:status'),
    provision: options => ipcRenderer.invoke('agentx:account:provision', options)
  },
  // The machines this person is signed in on, and the way to cut one off.
  // `revoke` takes the id of the device to remove — which may be this one; the
  // service is what decides whether that is allowed.
  devices: {
    list: () => ipcRenderer.invoke('agentx:devices:list'),
    revoke: (id, options) => ipcRenderer.invoke('agentx:devices:revoke', { id, ...options })
  },
  // Conversation history, across this person's machines. `tick` is also how
  // the backend receives a bearer at all — it holds no credential of its own —
  // so Settings asking for a sync is a real trigger and not just a refresh.
  sync: {
    status: () => ipcRenderer.invoke('agentx:sync:status'),
    tick: () => ipcRenderer.invoke('agentx:sync:tick')
  },
  profile: {
    get: () => ipcRenderer.invoke('agentx:profile:get'),
    set: name => ipcRenderer.invoke('agentx:profile:set', name)
  },
  api: request => ipcRenderer.invoke('agentx:api', request),
  notify: payload => ipcRenderer.invoke('agentx:notify', payload),
  requestMicrophoneAccess: () => ipcRenderer.invoke('agentx:requestMicrophoneAccess'),
  readFileDataUrl: filePath => ipcRenderer.invoke('agentx:readFileDataUrl', filePath),
  readFileDataUrlForAttach: filePath => ipcRenderer.invoke('agentx:readFileDataUrlForAttach', filePath),
  dataUrlReadMax: {
    get: () => ipcRenderer.invoke('agentx:data-url-read-max:get'),
    set: maxMb => ipcRenderer.invoke('agentx:data-url-read-max:set', maxMb)
  },
  readFileText: filePath => ipcRenderer.invoke('agentx:readFileText', filePath),
  selectPaths: options => ipcRenderer.invoke('agentx:selectPaths', options),
  selectSavePath: options => ipcRenderer.invoke('agentx:selectSavePath', options),
  writeClipboard: text => ipcRenderer.invoke('agentx:writeClipboard', text),
  readClipboard: () => ipcRenderer.invoke('agentx:readClipboard'),
  saveImageFromUrl: url => ipcRenderer.invoke('agentx:saveImageFromUrl', url),
  saveImageBuffer: (data, ext) => ipcRenderer.invoke('agentx:saveImageBuffer', { data, ext }),
  saveClipboardImage: () => ipcRenderer.invoke('agentx:saveClipboardImage'),
  getPathForFile: file => {
    try {
      return webUtils.getPathForFile(file) || ''
    } catch {
      return ''
    }
  },
  normalizePreviewTarget: (target, baseDir) => ipcRenderer.invoke('agentx:normalizePreviewTarget', target, baseDir),
  watchPreviewFile: url => ipcRenderer.invoke('agentx:watchPreviewFile', url),
  watchDirectory: dir => ipcRenderer.invoke('agentx:watchDirectory', dir),
  stopPreviewFileWatch: id => ipcRenderer.invoke('agentx:stopPreviewFileWatch', id),
  setActiveWork: payload => ipcRenderer.send('agentx:active-work', payload),
  setTitleBarTheme: payload => ipcRenderer.send('agentx:titlebar-theme', payload),
  setNativeTheme: mode => ipcRenderer.send('agentx:native-theme', mode),
  setTranslucency: payload => ipcRenderer.send('agentx:translucency', payload),
  setKeepAwake: on => ipcRenderer.send('agentx:keep-awake', on),
  setPreviewShortcutActive: active => ipcRenderer.send('agentx:previewShortcutActive', Boolean(active)),
  openExternal: url => ipcRenderer.invoke('agentx:openExternal', url),
  openPreviewInBrowser: url => ipcRenderer.invoke('agentx:openPreviewInBrowser', url),
  fetchLinkTitle: url => ipcRenderer.invoke('agentx:fetchLinkTitle', url),
  sanitizeWorkspaceCwd: cwd => ipcRenderer.invoke('agentx:workspace:sanitize', cwd),
  settings: {
    getDefaultProjectDir: () => ipcRenderer.invoke('agentx:setting:defaultProjectDir:get'),
    setDefaultProjectDir: dir => ipcRenderer.invoke('agentx:setting:defaultProjectDir:set', dir),
    pickDefaultProjectDir: () => ipcRenderer.invoke('agentx:setting:defaultProjectDir:pick')
  },
  zoom: {
    // Current zoom of this window, as { level, percent }.
    get: () => ipcRenderer.invoke('agentx:zoom:get'),
    setPercent: percent => ipcRenderer.send('agentx:zoom:set-percent', percent),
    // Fires on every zoom change, including the Ctrl/Cmd +/-/0 shortcuts,
    // so the settings UI can stay in sync with the keyboard.
    onChanged: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('agentx:zoom:changed', listener)

      return () => ipcRenderer.removeListener('agentx:zoom:changed', listener)
    }
  },
  revealLogs: () => ipcRenderer.invoke('agentx:logs:reveal'),
  getRecentLogs: () => ipcRenderer.invoke('agentx:logs:recent'),
  readDir: dirPath => ipcRenderer.invoke('agentx:fs:readDir', dirPath),
  gitRoot: startPath => ipcRenderer.invoke('agentx:fs:gitRoot', startPath),
  revealPath: targetPath => ipcRenderer.invoke('agentx:fs:reveal', targetPath),
  openDir: dirPath => ipcRenderer.invoke('agentx:fs:openDir', dirPath),
  desktopPluginsRoot: () => ipcRenderer.invoke('agentx:fs:desktopPluginsRoot'),
  renamePath: (targetPath, newName) => ipcRenderer.invoke('agentx:fs:rename', targetPath, newName),
  writeTextFile: (filePath, content) => ipcRenderer.invoke('agentx:fs:writeText', filePath, content),
  trashPath: targetPath => ipcRenderer.invoke('agentx:fs:trash', targetPath),
  git: {
    worktreeList: repoPath => ipcRenderer.invoke('agentx:git:worktreeList', repoPath),
    worktreeAdd: (repoPath, options) => ipcRenderer.invoke('agentx:git:worktreeAdd', repoPath, options),
    worktreeRemove: (repoPath, worktreePath, options) =>
      ipcRenderer.invoke('agentx:git:worktreeRemove', repoPath, worktreePath, options),
    branchSwitch: (repoPath, branch) => ipcRenderer.invoke('agentx:git:branchSwitch', repoPath, branch),
    branchList: repoPath => ipcRenderer.invoke('agentx:git:branchList', repoPath),
    baseBranchList: repoPath => ipcRenderer.invoke('agentx:git:baseBranchList', repoPath),
    repoStatus: repoPath => ipcRenderer.invoke('agentx:git:repoStatus', repoPath),
    fileDiff: (repoPath, filePath) => ipcRenderer.invoke('agentx:git:fileDiff', repoPath, filePath),
    scanRepos: (roots, options) => ipcRenderer.invoke('agentx:git:scanRepos', roots, options),
    review: {
      list: (repoPath, scope, baseRef) => ipcRenderer.invoke('agentx:git:review:list', repoPath, scope, baseRef),
      diff: (repoPath, filePath, scope, baseRef, staged) =>
        ipcRenderer.invoke('agentx:git:review:diff', repoPath, filePath, scope, baseRef, staged),
      stage: (repoPath, filePath) => ipcRenderer.invoke('agentx:git:review:stage', repoPath, filePath),
      unstage: (repoPath, filePath) => ipcRenderer.invoke('agentx:git:review:unstage', repoPath, filePath),
      revert: (repoPath, filePath) => ipcRenderer.invoke('agentx:git:review:revert', repoPath, filePath),
      revParse: (repoPath, ref) => ipcRenderer.invoke('agentx:git:review:revParse', repoPath, ref),
      commit: (repoPath, message, push) => ipcRenderer.invoke('agentx:git:review:commit', repoPath, message, push),
      commitContext: repoPath => ipcRenderer.invoke('agentx:git:review:commitContext', repoPath),
      push: repoPath => ipcRenderer.invoke('agentx:git:review:push', repoPath),
      shipInfo: repoPath => ipcRenderer.invoke('agentx:git:review:shipInfo', repoPath),
      createPr: repoPath => ipcRenderer.invoke('agentx:git:review:createPr', repoPath)
    }
  },
  terminal: {
    cwd: id => ipcRenderer.invoke('agentx:terminal:cwd', id),
    dispose: id => ipcRenderer.invoke('agentx:terminal:dispose', id),
    resize: (id, size) => ipcRenderer.invoke('agentx:terminal:resize', id, size),
    start: options => ipcRenderer.invoke('agentx:terminal:start', options),
    write: (id, data) => ipcRenderer.invoke('agentx:terminal:write', id, data),
    onData: (id, callback) => {
      const channel = `agentx:terminal:${id}:data`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    },
    onExit: (id, callback) => {
      const channel = `agentx:terminal:${id}:exit`
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)

      return () => ipcRenderer.removeListener(channel, listener)
    }
  },
  onClosePreviewRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('agentx:close-preview-requested', listener)

    return () => ipcRenderer.removeListener('agentx:close-preview-requested', listener)
  },
  onOpenFolderRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('agentx:open-folder-requested', listener)

    return () => ipcRenderer.removeListener('agentx:open-folder-requested', listener)
  },
  onOpenUpdatesRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('agentx:open-updates', listener)

    return () => ipcRenderer.removeListener('agentx:open-updates', listener)
  },
  onDeepLink: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('agentx:deep-link', listener)

    return () => ipcRenderer.removeListener('agentx:deep-link', listener)
  },
  signalDeepLinkReady: () => ipcRenderer.invoke('agentx:deep-link-ready'),
  onWindowStateChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('agentx:window-state-changed', listener)

    return () => ipcRenderer.removeListener('agentx:window-state-changed', listener)
  },
  onFocusSession: callback => {
    const listener = (_event, sessionId) => callback(sessionId)
    ipcRenderer.on('agentx:focus-session', listener)

    return () => ipcRenderer.removeListener('agentx:focus-session', listener)
  },
  onNotificationAction: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('agentx:notification-action', listener)

    return () => ipcRenderer.removeListener('agentx:notification-action', listener)
  },
  onPreviewFileChanged: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('agentx:preview-file-changed', listener)

    return () => ipcRenderer.removeListener('agentx:preview-file-changed', listener)
  },
  onBackendExit: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('agentx:backend-exit', listener)

    return () => ipcRenderer.removeListener('agentx:backend-exit', listener)
  },
  // Soft gateway-mode apply finished tearing down the primary backend. Renderer
  // should wipe session lists + re-dial without a window reload.
  onConnectionApplied: callback => {
    const listener = () => callback()
    ipcRenderer.on('agentx:connection:applied', listener)

    return () => ipcRenderer.removeListener('agentx:connection:applied', listener)
  },
  onPowerResume: callback => {
    const listener = () => callback()
    ipcRenderer.on('agentx:power-resume', listener)

    return () => ipcRenderer.removeListener('agentx:power-resume', listener)
  },
  // AC ↔ battery transitions; renderers slow their backstop polls on battery.
  getOnBattery: () => ipcRenderer.invoke('agentx:power-battery:get'),
  onBatteryChanged: callback => {
    const listener = (_event, onBattery) => callback(Boolean(onBattery))
    ipcRenderer.on('agentx:power-battery', listener)

    return () => ipcRenderer.removeListener('agentx:power-battery', listener)
  },
  onBootProgress: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('agentx:boot-progress', listener)

    return () => ipcRenderer.removeListener('agentx:boot-progress', listener)
  },
  // First-launch bootstrap progress -- emitted by the install.ps1 stage
  // runner in main.ts (apps/desktop/electron/bootstrap-runner.ts).
  // Renderer's install overlay subscribes to live events and queries the
  // current snapshot via getBootstrapState() to recover after a devtools
  // reload mid-bootstrap.
  getBootstrapState: () => ipcRenderer.invoke('agentx:bootstrap:get'),
  continueBootstrapLocal: () => ipcRenderer.invoke('agentx:bootstrap:continue-local'),
  resetBootstrap: () => ipcRenderer.invoke('agentx:bootstrap:reset'),
  repairBootstrap: () => ipcRenderer.invoke('agentx:bootstrap:repair'),
  cancelBootstrap: () => ipcRenderer.invoke('agentx:bootstrap:cancel'),
  onBootstrapEvent: callback => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('agentx:bootstrap:event', listener)

    return () => ipcRenderer.removeListener('agentx:bootstrap:event', listener)
  },
  getVersion: () => ipcRenderer.invoke('agentx:version'),
  getRemoteDisplayReason: () => ipcRenderer.invoke('agentx:get-remote-display-reason'),
  uninstall: {
    summary: () => ipcRenderer.invoke('agentx:uninstall:summary'),
    run: mode => ipcRenderer.invoke('agentx:uninstall:run', { mode })
  },
  updates: {
    check: () => ipcRenderer.invoke('agentx:updates:check'),
    apply: opts => ipcRenderer.invoke('agentx:updates:apply', opts),
    getBranch: () => ipcRenderer.invoke('agentx:updates:branch:get'),
    setBranch: name => ipcRenderer.invoke('agentx:updates:branch:set', name),
    onProgress: callback => {
      const listener = (_event, payload) => callback(payload)
      ipcRenderer.on('agentx:updates:progress', listener)

      return () => ipcRenderer.removeListener('agentx:updates:progress', listener)
    }
  },
  themes: {
    fetchMarketplace: id => ipcRenderer.invoke('agentx:vscode-theme:fetch', id),
    searchMarketplace: query => ipcRenderer.invoke('agentx:vscode-theme:search', query)
  },
  // Find-in-page (Ctrl/Cmd+F): delegates to Electron's
  // webContents.findInPage on the IPC sender's window so a Cmd+F pressed
  // in a secondary session window searches THAT window, not the primary.
  // `onFoundInPage` returns the unsubscribe fn; the renderer wires it via
  // `initFindInPageListener` in store/find-in-page.ts and tears it down
  // when the FindBar unmounts.
  findInPage: (query, options) => ipcRenderer.invoke('agentx:find-in-page', query, options),
  stopFindInPage: () => ipcRenderer.invoke('agentx:stop-find-in-page'),
  onFoundInPage: callback => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('agentx:found-in-page', listener)

    return () => ipcRenderer.removeListener('agentx:found-in-page', listener)
  }
})
