import { RouteSkeleton } from '../../components/loading-skeleton'
// The leaderboard query runs before this page renders, so it keeps a route-level skeleton.
// Pages whose shell needs no slow data deliberately have none: a route loading boundary streams
// the whole page hidden until hydration, which delayed LCP by 3-6 s on mobile.
export default function Loading() { return <RouteSkeleton title="Loading discoverers"/> }
