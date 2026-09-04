import { describe, expect, it } from 'vitest'

import { classifyBootFailure } from './boot-failure-kind'

describe('classifyBootFailure', () => {
  it('reads the slow-first-answer failure as a timeout', () => {
    expect(
      classifyBootFailure(
        "Error invoking remote method 'agentx:connection': Error: Timed out connecting to AgentX backend after 8000ms"
      )
    ).toBe('timeout')
    expect(classifyBootFailure('AgentX backend did not become ready: 503: Service Unavailable')).toBe('timeout')
    expect(classifyBootFailure('connect ETIMEDOUT 127.0.0.1:50603')).toBe('timeout')
  })

  it('reads a process that died as an exit, even when it died before its port announcement', () => {
    expect(classifyBootFailure('AgentX backend exited before it became ready (1). Log: /x/desktop.log')).toBe('exited')
    expect(classifyBootFailure('AgentX backend: exited before port announcement (SIGTERM)')).toBe('exited')
    expect(classifyBootFailure('AgentX background process exited during startup.')).toBe('exited')
  })

  it('reads a missing port announcement as a port failure', () => {
    expect(classifyBootFailure('Timed out waiting for AgentX backend port announcement (90000ms)')).toBe('port')
  })

  it('reads a rejected real-time channel as a websocket failure', () => {
    expect(
      classifyBootFailure(
        'Local AgentX backend is HTTP-reachable but the WebSocket (/api/ws) rejected the sign-in ticket: 403'
      )
    ).toBe('websocket')
  })

  it('reads installer failures as install', () => {
    expect(classifyBootFailure("AgentX bootstrap failed at stage 'venv': python not found. Check /x/desktop.log")).toBe(
      'install'
    )
    expect(classifyBootFailure('AgentX install was cancelled.')).toBe('install')
  })

  it('falls back to unknown for anything else, including nothing', () => {
    expect(classifyBootFailure('Could not connect to AgentX gateway')).toBe('unknown')
    expect(classifyBootFailure('')).toBe('unknown')
    expect(classifyBootFailure(null)).toBe('unknown')
    expect(classifyBootFailure(undefined)).toBe('unknown')
  })
})
