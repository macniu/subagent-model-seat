/**
 * Host half — subagent-model-seat.
 *
 * Why this exists at all: the stock Host entry for changing a Session's model is
 * `session.selectModel`, and it resolves the Session through
 * `ApiSessionAgentController.resolveAgent`, which rejects every Session whose
 * header origin is 'subagent' with
 *
 *   session/agent-busy: session "<id>" is owned by subagent routing
 *
 * (see `dsh-api-session-controller/src/agent.ts` — `hasApiSessionSubagentOwner`
 * plus `apiSessionSubagentOwnershipError`). That gate is deliberate: subagent
 * Sessions are driven by their parent's routing, so the generic Session RPC
 * stays out of them. It also means the composer model seat can never work in a
 * subagent conversation through the stock RPC.
 *
 * The write itself is not gated. A model switch is one `model/selection` event
 * appended to the Session log, and nothing about that append depends on
 * `session.header.origin`. So this plugin exposes exactly one narrow, same-origin
 * route that performs the two steps the stock command performs after resolving
 * the Agent — validate the route against the LLM catalog, then record the
 * selection — and nothing else.
 *
 * Two write paths, because a subagent conversation usually has no live Agent:
 *
 *   1. live Agent  — `ctx.agents.get(id)` hits, so reuse `agent.model.select`
 *      exactly like the stock command. This also drives the in-memory model
 *      projection, so the running Agent's next step uses the new route.
 *   2. cold log    — a historical subagent has no Agent at all: `resolveAgent`
 *      refuses to resume it (`resumeObserved` throws `ApiSessionSubagentOwnership`
 *      for origin 'subagent') and `SubagentManager` disposes the Agent when the
 *      child finishes. Here the selection is appended straight to the stored
 *      log through `ctx.sessionPersistence`, which is the same channel the
 *      built-in message-feedback service uses for sessions that are not live.
 *      The choice takes effect the next time the conversation is read.
 *
 * Deliberately small surface:
 *   - one exact POST route, behind the same connection trust fence the official
 *     open-in-app routes use (`connection.requestRejection`);
 *   - no new Remote/typert surface, no schema, no persisted state of ours;
 *   - the reasoning effort is only forwarded when the caller sends one, so a
 *     model-only switch keeps the Session's own default effort.
 */

/** Same-origin JSON endpoint the Client half posts a selection to. */
export const SELECT_PATH = '/subagent-model-seat/select'

/** Request bodies are tiny by contract; anything larger is not from our Client half. */
const MAX_BODY_BYTES = 8 * 1024

/** Services this half needs before `apply` runs. */
export const inject = ['webServer', 'connection', 'llm', 'agents', 'sessions', 'sessionPersistence']

/**
 * Trust surface consumed here; the browser-side connection package owns the full type.
 * @typedef {{ requestRejection(request: { readonly headers: import('node:http').IncomingMessage['headers'] }): 401 | 403 | undefined }} SeatConnection
 */

/**
 * The composition's connection service (typed locally: its package is browser-side).
 * @param {any} ctx
 * @returns {SeatConnection}
 */
function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * Answer one JSON response. No-store: a selection outcome is a live fact.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/**
 * Collect a bounded request body as UTF-8 text; null past the ceiling (stream drained).
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<string | null>}
 */
async function readBoundedBody(req) {
  const chunks = []
  let size = 0
  // http server streams without setEncoding always yield Buffer chunks.
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > MAX_BODY_BYTES) {
      // Drain the remainder so the refusal is a readable response, not a socket cut.
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Validate one request body at the wire: JSON object with three strings and one optional string.
 * @param {string} text
 * @returns {{ sessionId: string, provider: string, model: string, reasoningEffort?: string } | null}
 */
function parseSelectBody(text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    // Swallows the parse error: a non-JSON body is exactly the null case.
    return null
  }
  if (typeof body !== 'object' || body === null) return null
  const { sessionId, provider, model, reasoningEffort } = body
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  if (typeof provider !== 'string' || provider.length === 0) return null
  if (typeof model !== 'string' || model.length === 0) return null
  if (reasoningEffort !== undefined && typeof reasoningEffort !== 'string') return null
  return reasoningEffort === undefined || reasoningEffort.length === 0
    ? { sessionId, provider, model }
    : { sessionId, provider, model, reasoningEffort }
}

/**
 * Whether a Session already records exactly this selection.
 * @param {unknown} recorded
 * @param {{ provider: string, model: string, reasoningEffort?: string }} selected
 */
function sameSelection(recorded, selected) {
  if (typeof recorded !== 'object' || recorded === null) return false
  const value = /** @type {Record<string, unknown>} */ (recorded)
  return value['provider'] === selected.provider
    && value['model'] === selected.model
    && value['reasoningEffort'] === selected.reasoningEffort
}

/**
 * Append the selection to a Session log that has no live Agent.
 *
 * A live Session (attached to the store but without an Agent) is written through
 * the store so projections see it immediately; otherwise the stored log is
 * opened for writing, exactly like `dsh-message-feedback` does for cold Sessions.
 *
 * @param {any} ctx
 * @param {string} sessionId
 * @param {{ provider: string, model: string, reasoningEffort?: string }} selected
 * @returns {Promise<{ changed: boolean }>}
 */
async function appendToColdLog(ctx, sessionId, selected) {
  const event = { type: 'model/selection', data: selected }

  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) {
    live.append(event.type, event.data)
    if (!(await ctx.sessions.flush(live))) {
      throw new Error(`subagent-model-seat: no durability listener participated for live session '${sessionId}'`)
    }
    return { changed: true }
  }

  const handle = await ctx.sessionPersistence.open(sessionId, 'write')
  try {
    const { events } = await handle.read()
    const last = events.at(-1)
    if (last !== undefined && last.type === 'model/selection' && sameSelection(last.data, selected)) {
      return { changed: false }
    }
    // `seq` continues the valid contiguous log; `time` is the commit stamp.
    await handle.append([{ ...event, seq: events.length, time: Date.now() }])
    await handle.flush()
    return { changed: true }
  } finally {
    await handle.close()
  }
}

/**
 * Whether the persistence backend knows this Session. A backend that cannot
 * answer `stat` is treated as "maybe stored" so an unusual backend degrades to
 * the write attempt (and its own error) instead of a false 404.
 * @param {any} ctx
 * @param {string} sessionId
 * @returns {Promise<boolean>}
 */
async function isStored(ctx, sessionId) {
  const persistence = ctx.sessionPersistence
  if (typeof persistence?.stat !== 'function') return true
  try {
    return await persistence.stat(sessionId) !== undefined
  } catch {
    // A stat failure is not proof of absence; let the write path report.
    return true
  }
}

/**
 * Register the one selection route.
 * @param {any} ctx
 */
export function apply(ctx) {
  /** Answer an untrusted/unauthenticated request; true when it was rejected. */
  const rejected = (req, res) => {
    const rejection = connectionOf(ctx).requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: SELECT_PATH,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          if (req.method !== 'POST') {
            res.statusCode = 405
            res.setHeader('allow', 'POST')
            res.end()
            return
          }
          const text = await readBoundedBody(req)
          if (text === null) {
            sendJson(res, 413, { ok: false, error: { code: 'seat/body-too-large', message: 'request body is too large' } })
            return
          }
          const request = parseSelectBody(text)
          if (request === null) {
            sendJson(res, 400, { ok: false, error: { code: 'seat/bad-request', message: 'expected { sessionId, provider, model, reasoningEffort? }' } })
            return
          }
          const selected = {
            provider: request.provider,
            model: request.model,
            ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
          }
          try {
            // Same order as the stock command: validate the route, then record it.
            await ctx.llm.resolveCallConfig(selected)
          } catch (error) {
            sendJson(res, 409, {
              ok: false,
              error: {
                code: 'seat/model-unavailable',
                message: error instanceof Error ? error.message : String(error),
              },
            })
            return
          }
          /** `agents.get` does not read `session.header.origin`, so a live child Agent is found here. */
          const agent = ctx.agents.get(request.sessionId)
          if (agent === undefined
            && ctx.sessions.get(request.sessionId) === undefined
            && !(await isStored(ctx, request.sessionId))) {
            sendJson(res, 404, {
              ok: false,
              error: { code: 'seat/session-not-found', message: `session "${request.sessionId}" is not stored` },
            })
            return
          }
          try {
            if (agent !== undefined) {
              agent.model.select(selected)
            } else {
              await appendToColdLog(ctx, request.sessionId, selected)
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const writerHeld = /writer|ownership|already open/i.test(message)
            sendJson(res, writerHeld ? 409 : 500, {
              ok: false,
              error: {
                code: writerHeld ? 'session/writer-held' : 'seat/write-failed',
                message,
              },
            })
            return
          }
          sendJson(res, 200, { ok: true, selected, live: agent !== undefined })
        },
      }),
    `subagent-model-seat: POST ${SELECT_PATH}`,
  )
}
