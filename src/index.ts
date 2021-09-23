import { isFunction, parseConfig } from './helpers'
import {
  EmitterMethods,
  getEmitter,
  extendWithEmitterMethods,
} from './event-emitter'
import { Config } from '../types'

export const EmitterEvents = {
  cacheHit: 'cacheHit',
  cacheExpired: 'cacheExpired',
  cacheMiss: 'cacheMiss',
  invoke: 'invoke',
  revalidate: 'revalidate',
  revalidateFailed: 'revalidateFailed',
} as const

type StaleWhileRevalidateCache = <ReturnValue extends unknown>(
  cacheKey: string | (() => string),
  fn: () => ReturnValue
) => Promise<ReturnValue>

type StaleWhileRevalidate = StaleWhileRevalidateCache & EmitterMethods

export function createStaleWhileRevalidateCache(
  config: Config
): StaleWhileRevalidate {
  const {
    storage,
    minTimeToStale,
    maxTimeToLive,
    serialize,
    deserialize,
  } = parseConfig(config)

  const emitter = getEmitter()

  async function staleWhileRevalidate<ReturnValue extends unknown>(
    cacheKey: string | (() => string),
    fn: () => ReturnValue
  ): Promise<ReturnValue> {
    emitter.emit(EmitterEvents.invoke, { cacheKey, fn })

    const key = isFunction(cacheKey) ? String(cacheKey()) : String(cacheKey)
    const timeKey = `${key}_time`

    async function revalidate() {
      try {
        emitter.emit(EmitterEvents.revalidate, { cacheKey, fn })

        const result = await fn()

        // Intentionally persisting asynchronously and not blocking since there is
        // in any case a chance for a race condition to occur when using an external
        // persistence store, like Redis, with multiple consumers. The impact is low.
        storage.setItem(key, serialize(result))
        storage.setItem(timeKey, Date.now().toString())

        return result
      } catch (error) {
        emitter.emit(EmitterEvents.revalidateFailed, { cacheKey, fn, error })
        throw error
      }
    }

    let [cachedValue, cachedTime] = await Promise.all([
      storage.getItem(key),
      storage.getItem(timeKey),
    ])

    cachedValue = deserialize(cachedValue)

    const now = Date.now()
    const cachedAge = now - Number(cachedTime)

    if (cachedAge > maxTimeToLive) {
      emitter.emit(EmitterEvents.cacheExpired, {
        cacheKey,
        cachedAge,
        cachedTime,
        cachedValue,
        maxTimeToLive,
      })
      cachedValue = null
    }

    if (cachedValue) {
      emitter.emit(EmitterEvents.cacheHit, { cacheKey, cachedValue })

      if (cachedAge >= minTimeToStale) {
        // Non-blocking so that revalidation runs while stale cache data is returned
        // Error handled in `revalidate` by emitting an event, so only need a no-op here
        revalidate().catch(() => {})
      }

      return cachedValue as ReturnValue
    }

    emitter.emit(EmitterEvents.cacheMiss, { cacheKey, fn })

    return revalidate()
  }

  return extendWithEmitterMethods(emitter, staleWhileRevalidate)
}
