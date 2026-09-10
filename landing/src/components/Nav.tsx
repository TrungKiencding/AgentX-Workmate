import { useEffect, useId, useState } from 'react'

import { LOCALES, LOCALE_LABELS, useI18n, type Locale } from '../i18n'
import { LINKS } from '../lib/links'
import { BrandMark } from './BrandMark'

const SECTIONS = [
  { key: 'features', href: '#kha-nang' },
  { key: 'how', href: '#bat-dau' },
  { key: 'download', href: '#tai-ve' }
] as const

/**
 * N5 · Floating pill.
 *
 * Content-sized and visibly detached, so the canvas bloom shows through the
 * blur behind it. Below 60rem the link rail collapses into a sheet rather than
 * letting the labels wrap — a nav link on two lines reads as a bug, and the
 * Vietnamese labels are the longest of the four locales.
 *
 * The language control is a real `<select>`. A hand-rolled menu here would be
 * one more thing to get wrong on a keyboard and on a phone; the native control
 * already knows how to be both.
 */
export function Nav() {
  const { t, locale, setLocale } = useI18n()
  const [open, setOpen] = useState(false)
  const sheetId = useId()
  const selectId = useId()

  // A sheet that survives a resize into the desktop layout would leave the page
  // scroll-locked with no visible way out.
  useEffect(() => {
    if (!open) {
      return
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const media = window.matchMedia('(min-width: 60rem)')
    const onWide = () => media.matches && setOpen(false)

    document.addEventListener('keydown', onKey)
    media.addEventListener('change', onWide)
    document.body.dataset.sheetOpen = 'true'

    return () => {
      document.removeEventListener('keydown', onKey)
      media.removeEventListener('change', onWide)
      delete document.body.dataset.sheetOpen
    }
  }, [open])

  const language = (
    <div className="nav__lang">
      <label className="sr-only" htmlFor={selectId}>
        {t.nav.language}
      </label>
      <select
        className="nav__select"
        id={selectId}
        onChange={event => setLocale(event.target.value as Locale)}
        value={locale}
      >
        {LOCALES.map(code => (
          <option key={code} value={code}>
            {LOCALE_LABELS[code]}
          </option>
        ))}
      </select>
      <svg aria-hidden="true" className="nav__chev" height="12" viewBox="0 0 12 12" width="12">
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.4" />
      </svg>
    </div>
  )

  return (
    <>
      <a className="skip" href="#main">
        {t.nav.skipToContent}
      </a>

      <nav aria-label="AgentX Workmate" className="nav">
        <a className="nav__wordmark" href="#top">
          <BrandMark size={22} weight={8} />
          <span className="nav__name">
            AgentX <span className="nav__name-2">Workmate</span>
          </span>
        </a>

        <ul className="nav__rail">
          {SECTIONS.map(item => (
            <li key={item.key}>
              <a className="nav__link" href={item.href}>
                {t.nav[item.key]}
              </a>
            </li>
          ))}
          <li>
            <a className="nav__link" href={LINKS.docs} rel="noreferrer" target="_blank">
              {t.nav.docs}
            </a>
          </li>
        </ul>

        <div className="nav__end">
          {language}
          <a className="btn btn--fill btn--sm nav__cta" href="#tai-ve">
            {t.nav.download}
          </a>
          <button
            aria-controls={sheetId}
            aria-expanded={open}
            aria-label={open ? t.nav.closeMenu : t.nav.openMenu}
            className="nav__burger"
            onClick={() => setOpen(value => !value)}
            type="button"
          >
            <span className="nav__burger-bar" data-open={open || undefined} />
            <span className="nav__burger-bar" data-open={open || undefined} />
          </button>
        </div>
      </nav>

      <div className="nav__sheet" data-open={open || undefined} hidden={!open} id={sheetId}>
        <ul>
          {SECTIONS.map(item => (
            <li key={item.key}>
              <a href={item.href} onClick={() => setOpen(false)}>
                {t.nav[item.key]}
              </a>
            </li>
          ))}
          <li>
            <a href={LINKS.docs} rel="noreferrer" target="_blank">
              {t.nav.docs}
            </a>
          </li>
          <li>
            <a href={LINKS.github} rel="noreferrer" target="_blank">
              GitHub
            </a>
          </li>
        </ul>
      </div>
    </>
  )
}
