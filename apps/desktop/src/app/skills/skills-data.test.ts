import { describe, expect, it } from 'vitest'

import { isHubSkill, skillMarkdownBody } from './skills-data'

describe('skillMarkdownBody', () => {
  it('drops the YAML frontmatter the dialog already renders as title, tags and description', () => {
    const skillMd =
      '---\nname: vneb\ndescription: Tra cứu VNEB.\nmetadata:\n  version: 1.0.0\n---\n\n# Tên skill\n\nÁp dụng khi…'

    expect(skillMarkdownBody(skillMd)).toBe('# Tên skill\n\nÁp dụng khi…')
  })

  it('leaves a SKILL.md without frontmatter alone, and a horizontal rule mid-document too', () => {
    expect(skillMarkdownBody('# Plain\n\nBody\n\n---\n\nMore')).toBe('# Plain\n\nBody\n\n---\n\nMore')
    expect(skillMarkdownBody('')).toBe('')
  })

  it('copes with Windows line endings and a BOM', () => {
    expect(skillMarkdownBody('\uFEFF---\r\nname: x\r\n---\r\nBody')).toBe('Body')
  })
})

describe('isHubSkill', () => {
  it('is the provenance the backend stamps on a store install', () => {
    const base = { name: 'x', description: '', category: 'general', enabled: true }

    expect(isHubSkill({ ...base, provenance: 'hub' })).toBe(true)
    expect(isHubSkill({ ...base, provenance: 'bundled' })).toBe(false)
    expect(isHubSkill({ ...base })).toBe(false)
  })
})
