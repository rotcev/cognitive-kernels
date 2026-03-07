import type {
  LensProcess, LensMetrics, LensBBEntry, LensHeuristic,
  LensDeferral, LensTerminalLine, LensEvent, LensDagNode,
  LensDagEdge, LensRun, LensSnapshot,
} from "./types.js";

export function mockProcesses(): LensProcess[] {
  return [
    {
      pid: "proc-metacog-001", type: "daemon", state: "running", name: "metacog",
      parentPid: null, role: "kernel",
      objective: "Orchestrate implementation of JWT authentication system.",
      priority: 100, tickCount: 42, tokensUsed: 3247, tokenBudget: 50000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 175000).toISOString(),
      lastActiveAt: new Date(Date.now() - 3000).toISOString(),
      children: ["proc-arch-002", "proc-impl-003", "proc-test-006"],
    },
    {
      pid: "proc-arch-002", type: "lifecycle", state: "dead", name: "architect",
      parentPid: "proc-metacog-001", role: "worker",
      objective: "Design the authentication system architecture.",
      priority: 90, tickCount: 15, tokensUsed: 4521, tokenBudget: null,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 170000).toISOString(),
      lastActiveAt: new Date(Date.now() - 120000).toISOString(),
      children: [], exitCode: 0, exitReason: "Architecture design committed to blackboard",
    },
    {
      pid: "proc-impl-003", type: "lifecycle", state: "running", name: "implementer",
      parentPid: "proc-metacog-001", role: "sub-kernel",
      objective: "Implement the authentication system based on the architecture.",
      priority: 80, tickCount: 28, tokensUsed: 8932, tokenBudget: 20000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 115000).toISOString(),
      lastActiveAt: new Date(Date.now() - 5000).toISOString(),
      children: ["proc-jwt-004", "proc-middleware-005"],
    },
    {
      pid: "proc-jwt-004", type: "lifecycle", state: "checkpoint", name: "jwt-handler",
      parentPid: "proc-impl-003", role: "worker",
      objective: "Implement JWT token generation and refresh rotation.",
      priority: 75, tickCount: 18, tokensUsed: 5200, tokenBudget: 8000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 100000).toISOString(),
      lastActiveAt: new Date(Date.now() - 30000).toISOString(),
      children: [],
      checkpoint: { reason: "Paused for test validation", savedAt: new Date(Date.now() - 30000).toISOString() },
    },
    {
      pid: "proc-middleware-005", type: "lifecycle", state: "running", name: "auth-middleware",
      parentPid: "proc-impl-003", role: "worker",
      objective: "Implement Express middleware for JWT validation and RBAC.",
      priority: 70, tickCount: 12, tokensUsed: 3100, tokenBudget: 6000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 80000).toISOString(),
      lastActiveAt: new Date(Date.now() - 8000).toISOString(),
      children: [],
    },
    {
      pid: "proc-test-006", type: "lifecycle", state: "sleeping", name: "test-writer",
      parentPid: "proc-metacog-001", role: "worker",
      objective: "Write comprehensive tests for the authentication system.",
      priority: 60, tickCount: 8, tokensUsed: 2100, tokenBudget: 10000,
      model: "claude-sonnet-4-20250514",
      spawnedAt: new Date(Date.now() - 110000).toISOString(),
      lastActiveAt: new Date(Date.now() - 45000).toISOString(),
      children: [],
    },
  ];
}

export function mockEdges(): LensDagEdge[] {
  return [
    { from: "proc-metacog-001", to: "proc-arch-002", relation: "parent-child" },
    { from: "proc-metacog-001", to: "proc-impl-003", relation: "parent-child" },
    { from: "proc-metacog-001", to: "proc-test-006", relation: "parent-child" },
    { from: "proc-impl-003", to: "proc-jwt-004", relation: "parent-child" },
    { from: "proc-impl-003", to: "proc-middleware-005", relation: "parent-child" },
    { from: "proc-arch-002", to: "proc-impl-003", relation: "dependency", label: "architecture design" },
    { from: "proc-jwt-004", to: "proc-test-006", relation: "dependency", label: "jwt module ready" },
  ];
}

export function mockDagNodes(): LensDagNode[] {
  return mockProcesses().map(p => ({
    pid: p.pid, name: p.name, type: p.type, state: p.state,
    role: p.role, priority: p.priority, parentPid: p.parentPid,
  }));
}

export function mockBlackboard(): Record<string, LensBBEntry> {
  return {
    "auth.architecture": { key: "auth.architecture", value: { jwt_strategy: "RS256", refresh: "rotation", middleware: "express" }, writer: "architect", readBy: ["implementer"] },
    "auth.jwt_structure": { key: "auth.jwt_structure", value: { header: { alg: "RS256", typ: "JWT" }, expiry: "15m", refreshExpiry: "7d" }, writer: "architect", readBy: ["jwt-handler"] },
    "auth.middleware_plan": { key: "auth.middleware_plan", value: { layers: ["token-extraction", "validation", "role-check"] }, writer: "architect", readBy: ["auth-middleware"] },
    "auth.jwt_module_status": { key: "auth.jwt_module_status", value: "implementation_complete_pending_review", writer: "jwt-handler", readBy: ["test-writer"] },
    "auth.token_schema": { key: "auth.token_schema", value: { accessToken: "string", refreshToken: "string", expiresIn: "number" }, writer: "jwt-handler", readBy: [] },
    "auth.middleware_progress": { key: "auth.middleware_progress", value: "80%", writer: "auth-middleware", readBy: ["metacog"] },
  };
}

export function mockHeuristics(): LensHeuristic[] {
  return [
    { id: "h-001", heuristic: "Spawn architect before implementer to establish design constraints", confidence: 0.89, context: "multi-module implementation", scope: "global", reinforcementCount: 3 },
    { id: "h-002", heuristic: "Checkpoint long-running processes before cross-process validation", confidence: 0.76, context: "test-driven workflows", scope: "local", reinforcementCount: 1 },
    { id: "h-003", heuristic: "Serialize final two agents when running 3+ parallel implementations", confidence: 0.64, context: "parallel implementation", scope: "global", reinforcementCount: 2 },
  ];
}

export function mockDeferrals(): LensDeferral[] {
  return [
    { id: "defer-001", name: "test-writer", conditionType: "blackboard_key_exists", conditionKey: "auth.jwt_module_status", waitedTicks: 14, reason: "Waiting for JWT module implementation to complete before writing tests" },
  ];
}

export function mockMetrics(): LensMetrics {
  return {
    totalTokens: 27101, tokenRate: 48, processCount: 6,
    runningCount: 3, sleepingCount: 1, deadCount: 1,
    wallTimeElapsedMs: 178000, tickCount: 42,
  };
}

export function mockEvents(): LensEvent[] {
  return [
    { action: "tick", status: "completed", timestamp: new Date(Date.now() - 3000).toISOString(), message: "tick=42 active=3 sleeping=1 dead=1 checkpointed=1" },
    { action: "llm", status: "started", timestamp: new Date(Date.now() - 4500).toISOString(), agentName: "auth-middleware", message: "Now I need to implement the role-based access control check..." },
    { action: "command", status: "completed", timestamp: new Date(Date.now() - 8000).toISOString(), agentName: "implementer", message: "write_blackboard: auth.middleware_progress = 80%" },
    { action: "checkpoint", status: "completed", timestamp: new Date(Date.now() - 30000).toISOString(), agentName: "jwt-handler", message: "Checkpoint created: waiting for test validation" },
    { action: "spawn", status: "completed", timestamp: new Date(Date.now() - 80000).toISOString(), agentName: "implementer", message: "Spawned auth-middleware (proc-middleware-005)" },
    { action: "spawn", status: "completed", timestamp: new Date(Date.now() - 100000).toISOString(), agentName: "implementer", message: "Spawned jwt-handler (proc-jwt-004)" },
    { action: "exit", status: "completed", timestamp: new Date(Date.now() - 120000).toISOString(), agentName: "architect", message: "Process exited with code 0" },
    { action: "spawn", status: "completed", timestamp: new Date(Date.now() - 170000).toISOString(), agentName: "metacog", message: "Spawned architect (proc-arch-002)" },
  ];
}

export function mockTerminalLines(): LensTerminalLine[] {
  return [
    { seq: 1, timestamp: new Date(Date.now() - 175000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "system", text: "Process spawned: metacog (daemon, priority=100)" },
    { seq: 2, timestamp: new Date(Date.now() - 174000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "info", text: "Goal: Implement authentication system with JWT tokens" },
    { seq: 3, timestamp: new Date(Date.now() - 173000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "thinking", text: "I need to break this into phases: 1) architecture, 2) implementation, 3) testing." },
    { seq: 4, timestamp: new Date(Date.now() - 170000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "tool", text: "os_spawn: architect (proc-arch-002)" },
    { seq: 5, timestamp: new Date(Date.now() - 120000).toISOString(), pid: "proc-metacog-001", processName: "metacog", level: "output", text: "Architect exited [0]. Architecture committed to blackboard." },
    { seq: 6, timestamp: new Date(Date.now() - 8000).toISOString(), pid: "proc-middleware-005", processName: "auth-middleware", level: "error", text: "TypeError: Cannot read property 'role' of undefined" },
  ];
}

export function mockRuns(): LensRun[] {
  return [
    { id: "b54ef6df", status: "running", goal: "Implement authentication system with JWT tokens and refresh flow", createdAt: new Date(Date.now() - 180000).toISOString(), elapsed: 178000 },
    { id: "a3c91f02", status: "completed", goal: "Set up database schema and migrations for user management", createdAt: new Date(Date.now() - 3600000).toISOString(), elapsed: 298000 },
    { id: "ff120e45", status: "failed", goal: "Refactor entire codebase to use dependency injection", createdAt: new Date(Date.now() - 7200000).toISOString(), elapsed: 200000 },
  ];
}

export function mockSnapshot(): LensSnapshot {
  return {
    runId: "b54ef6df",
    tick: 42,
    goal: "Implement authentication system with JWT tokens and refresh flow",
    elapsed: 178000,
    processes: mockProcesses(),
    dag: { nodes: mockDagNodes(), edges: mockEdges() },
    blackboard: mockBlackboard(),
    heuristics: mockHeuristics(),
    deferrals: mockDeferrals(),
    metrics: mockMetrics(),
  };
}
