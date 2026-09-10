import { useI18n } from '../i18n'
import { INSTALL, LINKS } from '../lib/links'
import { BrandMark } from './BrandMark'
import { CopyCommand } from './CopyCommand'

/**
 * The fold. Not `100dvh` and not a lone centred sentence — the height is the
 * height of its content, and the content is a claim, a paragraph that says what
 * the thing does, two ways in, and the literal install line.
 *
 * The oversized mark on the right is the one element that breaks the grid; it
 * is clipped by `html { overflow-x: clip }` rather than by a local `hidden`,
 * which would kill the sticky nav.
 */
export function Hero() {
  const { t } = useI18n()

  return (
    <header className="hero" id="top">
      <BrandMark className="hero__mark" size={620} weight={2.4} />

      <div className="hero__inner">
        <h1 className="hero__display reveal" style={{ '--i': 0 } as React.CSSProperties}>
          {t.hero.headline}
        </h1>

        <p className="hero__lede reveal" style={{ '--i': 1 } as React.CSSProperties}>
          {t.hero.lede}
        </p>

        <div className="hero__actions reveal" style={{ '--i': 2 } as React.CSSProperties}>
          <a className="btn btn--fill" href="#tai-ve">
            {t.hero.primaryCta}
          </a>
          <a className="btn btn--ghost" href={LINKS.github} rel="noreferrer" target="_blank">
            {t.hero.secondaryCta}
            <svg aria-hidden="true" height="14" viewBox="0 0 14 14" width="14">
              <path
                d="M4 10 10 4M10 4H5.2M10 4v4.8"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
              />
            </svg>
          </a>
        </div>

        <div className="hero__install reveal" style={{ '--i': 3 } as React.CSSProperties}>
          <CopyCommand command={INSTALL.unix} label={t.hero.installLabel} />
          <p className="hero__note">{t.hero.installNote}</p>
        </div>
      </div>
    </header>
  )
}
