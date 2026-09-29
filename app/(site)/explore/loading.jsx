import { RouteSkeleton } from '../../components/loading-skeleton'
// Unlike the token page, /explore measured slower without this (mobile LCP 3.8 s -> 5.2 s): its
// large market table benefits from painting the skeleton first and streaming the rest.
export default function Loading() { return <RouteSkeleton title="Loading markets" active="explore"/> }
