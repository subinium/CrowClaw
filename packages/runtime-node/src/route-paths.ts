export const routePaths = {
  code: {
    exec: '/api/code/exec',
    bridge: '/api/code/bridge',
    bridgeSpawn: '/api/code/bridge/spawn',
    bridgeTerminate: '/api/code/bridge/terminate',
    bridgeCapabilities: '/api/code/bridge/capabilities',
    bridgeProcess: '/api/code/bridge/process',
    bridgeCall: '/api/code/bridge/call',
    bridgePing: '/api/code/bridge/ping',
    bridgeStatus: '/api/code/bridge/status',
    bridgeTranscript: '/api/code/bridge/transcript',
    bridgeClose: '/api/code/bridge/close',
    bridgeHeartbeat: '/api/code/bridge/heartbeat',
    nodeExec: '/api/node/exec',
    pythonExec: '/api/python/exec'
  },
  browser: {
    session: '/api/browser/session',
    sessionReset: '/api/browser/session/reset'
  },
  terminal: {
    exec: '/api/terminal/exec',
    background: '/api/terminal/background',
    backends: '/api/terminal/backends',
    backendStatus: '/api/terminal/backend-status',
    probe: '/api/terminal/probe',
    processes: '/api/terminal/processes',
    kill: '/api/terminal/kill'
  },
  media: {
    vision: '/api/vision/analyze',
    image: '/api/image/generate'
  },
  mcp: {
    tools: '/api/mcp/tools',
    status: '/api/mcp/status',
    inspect: '/api/mcp/inspect',
    resources: '/api/mcp/resources',
    prompts: '/api/mcp/prompts',
    serverTools: '/api/mcp/server/tools',
    serverRequest: '/api/mcp/server/request'
  },
  acp: {
    info: '/api/acp/info',
    sessions: '/api/acp/sessions',
    prompt: '/api/acp/prompt',
    request: '/api/acp/request'
  },
  providers: {
    models: '/api/providers/models',
    route: '/api/providers/route',
    pool: '/api/providers/pool',
    plan: '/api/providers/plan',
    failoverPreview: '/api/providers/failover-preview',
    failoverSimulate: '/api/providers/failover-simulate'
  },
  config: {
    provider: '/api/config/provider',
    providerTest: '/api/config/provider/test',
    agent: '/api/config/agent',
  },
  providerConfig: {
    get: '/api/providers/config',
    save: '/api/providers/config',
    test: '/api/providers/test',
  },
  skills: '/api/skills',
  presets: '/api/presets',
  actions: {
    todo: '/api/todo',
    clarify: '/api/clarify',
    sendMessage: '/api/send-message'
  },
  gateway: {
    status: '/api/gateway/status'
  },
  system: {
    health: '/health',
    version: '/api/system/version',
    status: '/api/system/status',
    preflight: '/api/system/preflight',
    releaseCheck: '/api/system/release-check'
  },
  usage: {
    summary: '/api/usage',
    reset: '/api/usage/reset'
  },
  sessions: {
    list: '/api/sessions',
    create: '/api/sessions',
    stream: '/api/sessions/:id/stream'
  },
  personas: {
    list: '/api/personas',
    active: '/api/persona/active',
    switch: '/api/persona/switch'
  },
  configPresets: {
    list: '/api/config-presets',
    active: '/api/config-presets/active',
    switch: '/api/config-presets/switch',
    save: '/api/config-presets',
  },
  scheduler: {
    jobs: '/api/scheduler/jobs',
    tick: '/api/scheduler/tick',
    jobPause: '/api/scheduler/jobs/:id/pause',
    jobResume: '/api/scheduler/jobs/:id/resume',
    jobDelete: '/api/scheduler/jobs/:id',
    jobHistory: '/api/scheduler/jobs/:id/history',
    jobDryRun: '/api/scheduler/jobs/:id/dry-run',
    start: '/api/scheduler/start',
    stop: '/api/scheduler/stop',
    status: '/api/scheduler/status'
  }
} as const;

export function localRoute(path: string): string {
  return `http://localhost${path}`;
}
