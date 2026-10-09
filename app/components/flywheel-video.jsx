import { LazyPosterVideo } from './lazy-poster-video'

// Silent 42-second explainer. preload="none" keeps the video off the critical path, and the poster loads only when the
// player nears the viewport.
// launchFee: launchFeeTerms() of the config new launches use, or null when its fee is a flat 1.75%.
export function FlywheelVideo({ id = 'flywheel-video', launchFee = null }) {
  return <section className="flywheel-video" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>The repo.ing flywheel in 40 seconds</h2>
    <LazyPosterVideo controls muted playsInline preload="none" poster="/video/repoing-flywheel-poster.jpg" width="1280" height="720" aria-describedby={`${id}-description`}>
      <source src="/video/repoing-flywheel.mp4" type="video/mp4"/>
    </LazyPosterVideo>
    <p id={`${id}-description`}>Discover a public repo and launch its market. Every trade pays a 1.75% fee: 0.994% to the repo's builders, who claim it in SOL. New markets graduate at 85 SOL, older ones at about 30 SOL (each market page shows its target), and platform revenue buys back $REPOING.{launchFee && ` New markets also charge a launch fee in their first ${launchFee.durationLabel}: it starts at ${launchFee.startPercent} and falls to ${launchFee.endPercent}.`}</p>
  </section>
}
