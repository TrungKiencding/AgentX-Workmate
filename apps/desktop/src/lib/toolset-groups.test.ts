import { describe, expect, it } from 'vitest'

import { isDesktopToolsetVisible } from './desktop-toolsets'
import { TOOLSET_GROUP_IDS, toolsetGroup } from './toolset-groups'

// Every toolset the desktop can show, from `hermes_cli/tools_config.py`
// CONFIGURABLE_TOOLSETS. Kept here rather than fetched so a new backend entry
// shows up as a failing test — an unshelved tool falls into "Khác", which is
// where a person will never look for it.
const CONFIGURABLE = [
  'web',
  'browser',
  'terminal',
  'file',
  'code_execution',
  'vision',
  'video',
  'image_gen',
  'video_gen',
  'bfl',
  'x_search',
  'tts',
  'stt',
  'skills',
  'todo',
  'memory',
  'context_engine',
  'session_search',
  'clarify',
  'delegation',
  'cronjob',
  'homeassistant',
  'spotify',
  'discord',
  'discord_admin',
  'yuanbao',
  'computer_use'
]

describe('toolsetGroup', () => {
  it('shelves every tool the desktop shows', () => {
    const unshelved = CONFIGURABLE.filter(name => isDesktopToolsetVisible(name) && toolsetGroup(name) === 'other')

    expect(unshelved).toEqual([])
  })

  it('sends a toolset it has never heard of to the last shelf', () => {
    expect(toolsetGroup('some_plugin_toolset')).toBe('other')
  })

  it('puts the assistant machinery last, after every capability shelf', () => {
    expect(TOOLSET_GROUP_IDS.at(-1)).toBe('agent')
    expect(toolsetGroup('skills')).toBe('agent')
    expect(toolsetGroup('memory')).toBe('agent')
  })

  it('keeps the things that reach outside this machine apart from the things that act on it', () => {
    expect(toolsetGroup('web')).toBe('web')
    expect(toolsetGroup('terminal')).toBe('computer')
    expect(toolsetGroup('computer_use')).toBe('computer')
    expect(toolsetGroup('spotify')).toBe('apps')
  })
})
