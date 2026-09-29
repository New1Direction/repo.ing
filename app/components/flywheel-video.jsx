// Silent 42-second explainer. preload="none" keeps it off the critical path; the poster is small.
export function FlywheelVideo({ id = 'flywheel-video' }) {
  return <section className="flywheel-video" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>The repo.ing flywheel in 40 seconds</h2>
    <video controls muted playsInline preload="none" poster="/video/repoing-flywheel-poster.jpg" width="1280" height="720" aria-describedby={`${id}-description`}>
      <source src="/video/repoing-flywheel.mp4" type="video/mp4"/>
    </video>
    <p id={`${id}-description`}>Discover a public repo and launch its market. Every trade pays a 1.75% fee: 0.994% to the repo's builders, who claim it in SOL. At 85 SOL the market graduates, and platform revenue buys back $REPOING.</p>
  </section>
}
