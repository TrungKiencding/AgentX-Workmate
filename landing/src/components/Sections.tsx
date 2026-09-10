import { useI18n } from '../i18n'
import { BrandMark } from './BrandMark'
import { LINKS } from '../lib/links'
import { LearningLoop } from './LearningLoop'

/**
 * Section head. One column, always: the label-left / heading-right split is the
 * most reliable templated-editorial tell, and it collapses badly on a phone.
 * Alignment is a prop because the Bento grid below one head is symmetric while
 * the spec sheet below another is left-flush, and a head should agree with the
 * body it introduces.
 */
function Head({ align = 'start', lede, title }: { align?: 'start' | 'center'; lede: string; title: string }) {
  return (
    <div className="head" data-align={align}>
      <h2 className="head__title">{title}</h2>
      <p className="head__lede">{lede}</p>
    </div>
  )
}

/** T4 · Numbered stat strip. Every figure here is countable in the repository. */
export function FactStrip() {
  const { t } = useI18n()

  return (
    <section aria-label="AgentX Workmate" className="facts">
      <ul className="facts__list">
        {t.facts.map(fact => (
          <li className="facts__item" key={fact.label}>
            <span className="facts__value">{fact.value}</span>
            <span className="facts__label">{fact.label}</span>
            <span className="facts__note">{fact.note}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** F3 · Tabular spec sheet. Three columns on desktop, stacked blocks on a phone. */
export function Comparison() {
  const { t } = useI18n()
  const { comparison } = t

  return (
    <section className="section section--compare">
      <Head lede={comparison.lede} title={comparison.title} />

      <div className="spec" role="table">
        <div className="spec__head" role="row">
          <span role="columnheader" />
          <span className="spec__col spec__col--diy" role="columnheader">
            {comparison.columnDiy}
          </span>
          <span className="spec__col spec__col--ours" role="columnheader">
            {comparison.columnProduct}
          </span>
        </div>

        {comparison.rows.map(row => (
          <div className="spec__row" key={row.subject} role="row">
            <span className="spec__subject" role="rowheader">
              {row.subject}
            </span>
            <span className="spec__cell spec__cell--diy" role="cell">
              <span className="spec__mobile-label">{comparison.columnDiy}</span>
              {row.diy}
            </span>
            <span className="spec__cell spec__cell--ours" role="cell">
              <span className="spec__mobile-label">{comparison.columnProduct}</span>
              {row.product}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * F1 · Bento grid. Nine tiles on a 6-column mosaic — the first spans 3×2, the
 * browser tile runs tall, one runs wide. The variation in span is the rhythm;
 * nine identical cards with an icon over two lines of copy is the grid this is
 * deliberately not.
 */
export function Capabilities() {
  const { t } = useI18n()
  const { capabilities } = t

  return (
    <section className="section" id="kha-nang">
      <Head align="center" lede={capabilities.lede} title={capabilities.title} />

      <div className="bento">
        {capabilities.tiles.map(tile => (
          <article className={`tile tile--${tile.key}`} key={tile.key}>
            {tile.key === 'terminal' ? <BrandMark className="tile__mark" size={220} weight={3} /> : null}
            {tile.meta ? <span className="tile__meta">{tile.meta}</span> : null}
            <h3 className="tile__title">{tile.title}</h3>
            <p className="tile__body">{tile.body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

/** The page's focal artefact: the loop, drawn once when it comes into view. */
export function Loop() {
  const { t } = useI18n()
  const { loop } = t

  return (
    <section className="section section--loop">
      <div className="loop">
        <div className="loop__text">
          <h2 className="head__title">{loop.title}</h2>
          <p className="head__lede">{loop.lede}</p>

          <ol className="loop__steps">
            {loop.steps.map(step => (
              <li className="loop__step" key={step.n}>
                <span className="loop__n">{step.n}</span>
                <div>
                  <h3 className="loop__step-title">{step.title}</h3>
                  <p className="loop__step-body">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="loop__aside">{loop.aside}</p>
        </div>

        <LearningLoop title={loop.diagramTitle} />
      </div>
    </section>
  )
}

function ChipGroup({ items, label }: { items: readonly string[]; label: string }) {
  return (
    <div className="reach__group">
      <h3 className="reach__label">{label}</h3>
      <ul className="reach__chips">
        {items.map(item => (
          <li className="chip" key={item}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function Everywhere() {
  const { t } = useI18n()
  const { everywhere } = t

  return (
    <section className="section section--reach">
      <Head lede={everywhere.lede} title={everywhere.title} />

      <div className="reach">
        <ChipGroup items={everywhere.channels} label={everywhere.channelsLabel} />
        <ChipGroup items={everywhere.surfaces} label={everywhere.surfacesLabel} />
        <ChipGroup items={everywhere.runtimes} label={everywhere.runtimesLabel} />
        <div className="reach__group">
          <h3 className="reach__label">{everywhere.modelsLabel}</h3>
          <ul className="reach__chips">
            {everywhere.models.map(item => (
              <li className="chip" key={item}>
                {item}
              </li>
            ))}
          </ul>
          <p className="reach__note">{everywhere.modelsNote}</p>
        </div>
      </div>
    </section>
  )
}

/** F4 · Step sequence. Numbered because the steps genuinely happen in order. */
export function Steps() {
  const { t } = useI18n()
  const { steps } = t

  return (
    <section className="section" id="bat-dau">
      <Head lede={steps.lede} title={steps.title} />

      <ol className="steps">
        {steps.steps.map(step => (
          <li className="steps__item" key={step.n}>
            <span className="steps__n">{step.n}</span>
            <div className="steps__body">
              <h3 className="steps__title">{step.title}</h3>
              <p>{step.body}</p>
              {step.command ? <code className="steps__cmd">{step.command}</code> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function Faq() {
  const { t } = useI18n()

  return (
    <section className="section section--faq">
      <h2 className="head__title">{t.faq.title}</h2>

      <div className="faq">
        {t.faq.items.map(item => (
          <details className="faq__item" key={item.q}>
            <summary className="faq__q">
              <span>{item.q}</span>
              <svg aria-hidden="true" className="faq__sign" height="14" viewBox="0 0 14 14" width="14">
                <path d="M2 7h10" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
                <path
                  className="faq__sign-v"
                  d="M7 2v10"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="1.5"
                />
              </svg>
            </summary>
            <div className="faq__a">
              <p>{item.a}</p>
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}

/** Ft5 · Statement. The page closes on a sentence, not on a sitemap. */
export function Footer() {
  const { t } = useI18n()

  return (
    <footer className="foot">
      <p className="foot__statement">{t.footer.statement}</p>

      <div className="foot__meta">
        <span className="foot__brand">AgentX Workmate</span>
        <ul className="foot__links">
          {t.footer.links.map(link => (
            <li key={link.label}>
              <a href={link.href} rel="noreferrer" target="_blank">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
        <span className="foot__legal">
          <a href={LINKS.license} rel="noreferrer" target="_blank">
            {t.footer.license}
          </a>
          {' · '}
          {t.footer.builtBy}
        </span>
      </div>
    </footer>
  )
}
