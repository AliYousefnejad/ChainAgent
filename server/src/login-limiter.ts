// Counts failed sign-ins per network address in memory, so guessing emails (which an
// account lock can't catch) is throttled too. Resets when the API restarts.
// attempt() checks and books in one synchronous step, so parallel requests can't slip past;
// a successful sign-in calls undo() to give its booking back.
export type LoginLimiter = { attempt: (ip: string) => boolean; undo: (ip: string) => void }

const SWEEP_AT = 10_000 // forget expired addresses once this many are tracked

export function createLoginLimiter({ max = 20, windowMs = 15 * 60_000, now = Date.now } = {}): LoginLimiter {
  const failures = new Map<string, number[]>()

  const recent = (ip: string) => {
    const cutoff = now() - windowMs
    const times = (failures.get(ip) ?? []).filter((t) => t > cutoff)
    if (times.length) failures.set(ip, times)
    else failures.delete(ip)
    return times
  }

  return {
    attempt: (ip) => {
      if (failures.size > SWEEP_AT) for (const key of [...failures.keys()]) recent(key)
      const times = recent(ip)
      if (times.length >= max) return false
      failures.set(ip, [...times, now()])
      return true
    },
    undo: (ip) => {
      const times = failures.get(ip)
      times?.pop()
      if (times && !times.length) failures.delete(ip)
    }
  }
}
