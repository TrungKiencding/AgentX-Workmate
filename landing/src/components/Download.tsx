import { useI18n } from '../i18n'
import { INSTALL, LINKS } from '../lib/links'
import { CopyCommand } from './CopyCommand'

/**
 * The download section — the reason the page exists.
 *
 * Three platform cards, then the two literal one-liners for people who would
 * rather not click a button. The cards link to the Releases page rather than to
 * an asset URL; see `lib/links.ts` for why, and for the one place to change it.
 */
export function Download() {
  const { t } = useI18n()
  const { download } = t

  return (
    <section className="section section--download" id="tai-ve">
      <div className="head" data-align="center">
        <h2 className="head__title">{download.title}</h2>
        <p className="head__lede">{download.lede}</p>
      </div>

      <ul className="plats">
        {download.platforms.map(platform => (
          <li className="plat" key={platform.key}>
            <h3 className="plat__name">{platform.name}</h3>
            <p className="plat__detail">{platform.detail}</p>
            <a
              className="btn btn--fill btn--block"
              href={LINKS.download[platform.key as keyof typeof LINKS.download]}
              rel="noreferrer"
              target="_blank"
            >
              {platform.cta}
            </a>
          </li>
        ))}
      </ul>

      <p className="plats__note">{download.releaseNote}</p>

      <div className="cli">
        <h3 className="cli__title">{download.cliTitle}</h3>
        <div className="cli__rows">
          <CopyCommand command={INSTALL.unix} label={download.cliUnix} />
          <CopyCommand command={INSTALL.windows} label={download.cliWindows} />
        </div>
        <p className="cli__after">{download.cliAfter}</p>
        <p className="cli__reqs">{download.requirements}</p>
      </div>
    </section>
  )
}
