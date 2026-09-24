/**
 * process-tree.ts
 *
 * Stop a child process together with everything it started.
 *
 * child.kill() signals one process. The bootstrap's install.sh / install.ps1
 * is the root of a tree (git, uv, pip, `npx playwright install`), and
 * signalling only the script leaves the rest running: on POSIX they are
 * reparented to init and keep downloading into AGENTX_HOME after the app that
 * started them is gone.
 *
 * POSIX: the caller spawns the root `detached`, so it leads a process group
 * (and session) of its own and a signal to that group reaches everything that
 * stayed in it. It does not reach a job that moved to a group of its own,
 * which is exactly what install.sh's run_with_timeout does (`set -m`) for the
 * Playwright download. So the tree is read from `ps` and every group in it is
 * signalled: SIGTERM first, then SIGKILL for whatever is still there after a
 * grace period.
 *
 * Windows: taskkill /T /F, synchronously, while the root is still alive for
 * the walk to start from.
 *
 * Kept free of electron imports so it can be unit-tested directly.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { hiddenWindowsChildOptions } from './windows-child-options'

export interface ProcessEntry {
  pid: number
  ppid: number
  pgid: number
}

export interface ProcessTree {
  pids: number[]
  groups: number[]
}

export interface TerminateTreeOptions {
  /** How long the tree gets to exit on SIGTERM before it is sent SIGKILL. */
  graceMs?: number
  pollMs?: number
  platform?: NodeJS.Platform
  listProcesses?: () => ProcessEntry[] | null
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void
  taskkill?: (pid: number) => void
}

/** Every process on the machine, from one `ps` listing. Null when ps cannot be run. POSIX only. */
export function listProcesses(): ProcessEntry[] | null {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000
    })

    return out.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)

      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) }] : []
    })
  } catch {
    return null
  }
}

/**
 * What `rootPid` started and the process groups it all runs in: the root's
 * descendants, plus anything left in the root's group or in a group one of
 * them leads. The group part is how the tree is still found after the root has
 * exited and its children were reparented to init.
 *
 * Only groups led by the root or by something it started are listed, so
 * signalling them can never reach the caller's own group (led by the caller
 * or an ancestor of it). A root that the listing no longer shows is reached
 * through its group only, since its pid may already be in use again.
 */
export function collectProcessTree(processes: ProcessEntry[], rootPid: number): ProcessTree {
  const listed = processes.some(p => p.pid === rootPid)
  const pids = new Set<number>(listed ? [rootPid] : [])
  const groups = new Set<number>()

  // Spawned detached, the root leads a group named after it, and that group
  // outlives the root for as long as anything is left in it.
  if (processes.some(p => p.pgid === rootPid)) {
    groups.add(rootPid)
  }

  for (let grew = true; grew;) {
    grew = false

    for (const p of processes) {
      if (pids.has(p.pid) || p.pid <= 1 || !(pids.has(p.ppid) || groups.has(p.pgid))) {
        continue
      }

      pids.add(p.pid)

      if (p.pgid === p.pid) {
        groups.add(p.pgid)
      }

      grew = true
    }
  }

  return { pids: [...pids], groups: [...groups] }
}

// taskkill by absolute path first, as with the PowerShell lookup in
// bootstrap-runner.ts: a trimmed or unexpanded PATH must not keep a tree alive.
function resolveTaskkill(): string {
  for (const v of ['SystemRoot', 'windir']) {
    const root = process.env[v]

    if (root) {
      const candidate = path.join(root, 'System32', 'taskkill.exe')

      if (fs.existsSync(candidate)) {
        return candidate
      }
    }
  }

  return 'taskkill'
}

function taskkillTree(pid: number) {
  execFileSync(
    resolveTaskkill(),
    ['/PID', String(pid), '/T', '/F'],
    hiddenWindowsChildOptions({ stdio: 'ignore', timeout: 10_000 })
  )
}

/**
 * Stop `rootPid` and everything it started. Never throws.
 *
 * Returns a promise that settles once the tree is gone (POSIX: SIGTERM right
 * away, SIGKILL after `graceMs` for anything left), or null when the tree was
 * already stopped before returning (Windows). The SIGTERMs are sent before
 * this returns, so they are out even if the caller exits straight after.
 */
export function terminateProcessTree(rootPid: number, options: TerminateTreeOptions = {}): Promise<void> | null {
  const {
    graceMs = 3_000,
    pollMs = 100,
    platform = process.platform,
    listProcesses: list = listProcesses,
    kill = (pid, signal) => process.kill(pid, signal),
    taskkill = taskkillTree
  } = options

  const send = (target: number, signal: NodeJS.Signals | 0) => {
    try {
      kill(target, signal)

      return true
    } catch {
      return false
    }
  }

  if (platform === 'win32') {
    try {
      taskkill(rootPid)
    } catch {
      // taskkill missing or refused: at least stop the root.
      send(rootPid, 'SIGTERM')
    }

    return null
  }

  // Hold the root's group still while the tree is read, so the script cannot
  // start another job, in a group the listing would miss, between the
  // listing and the signal.
  send(-rootPid, 'SIGSTOP')

  // Without a listing, the root and its group are all there is to go on.
  let tree: ProcessTree = { pids: [rootPid], groups: [rootPid] }

  try {
    const processes = list()

    if (processes) {
      tree = collectProcessTree(processes, rootPid)
    }
  } catch {
    // Keep the root and its group.
  }

  const targets = [...tree.groups.map(group => -group), ...tree.pids]

  for (const target of targets) {
    send(target, 'SIGTERM')
  }

  // A stopped process only acts on its SIGTERM once it runs again. The root's
  // group was stopped above even if the listing left it out of the tree.
  for (const target of new Set([-rootPid, ...targets])) {
    send(target, 'SIGCONT')
  }

  return new Promise<void>(resolve => {
    const deadline = Date.now() + graceMs

    const check = () => {
      const left = targets.filter(target => send(target, 0))

      if (left.length > 0 && Date.now() < deadline) {
        setTimeout(check, pollMs)

        return
      }

      for (const target of left) {
        send(target, 'SIGKILL')
      }

      resolve()
    }

    setTimeout(check, pollMs)
  })
}
