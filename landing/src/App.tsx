import { Download } from './components/Download'
import { Hero } from './components/Hero'
import { Nav } from './components/Nav'
import { Capabilities, Comparison, Everywhere, FactStrip, Faq, Footer, Loop, Steps } from './components/Sections'

export function App() {
  return (
    <>
      {/* Two static blooms and a grain plate. Fixed, so they read as the room
          the page sits in rather than as decoration that scrolls with it. */}
      <div aria-hidden="true" className="canvas" />

      <Nav />

      <Hero />

      <main id="main">
        <FactStrip />
        <Comparison />
        <Capabilities />
        <Loop />
        <Everywhere />
        <Steps />
        <Download />
        <Faq />
      </main>

      <Footer />
    </>
  )
}
