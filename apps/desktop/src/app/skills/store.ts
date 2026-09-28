import { atom } from 'nanostores'

import { Codecs, persistentAtom } from '@/lib/persisted'

import type { StoreSegmentId } from './store-tab'

// Sort direction for the "Kỹ năng sẵn có" grid — persisted so the tab remembers
// most/least-used across navigations and restarts. The tools tab has no
// equivalent: its cards sit on fixed job shelves, A-Z inside each, so there is
// no order left to choose (see `filteredToolsets`).
export const $skillsSortDesc = persistentAtom('agentx.desktop.capabilities.skillsSortDesc', true, Codecs.bool)

// The kind Kho tiện ích last showed (Kỹ năng · MCP), so the store tab reopens
// on it within a session. Not persisted: a fresh start opens on skills.
export const $storeSegment = atom<StoreSegmentId>('hub')
