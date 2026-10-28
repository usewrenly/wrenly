// COMPONENT: Build event reader
// PURPOSE: Read chunked SSE and reject an unconfirmed terminal outcome.
// INPUTS: Response body and event callback.
// OUTPUTS: Parsed event payloads, or an actionable stream error.
// STEPS: Buffer lines, dispatch complete frames, require complete before EOF.
// EDGE CASES: CRLF, split UTF-8 and comments are accepted.
// ERROR STATES: Invalid JSON or premature EOF rejects the stream.

export interface BuildEvent {
  id?: string
  type: string
  data: Record<string, unknown>
}

/** Consumes SSE frames without assuming network chunks coincide with events. */
export async function readBuildEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: BuildEvent) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let complete = false
  const dispatch = (frame: string): void => {
    const lines = frame.split('\n').map((line) => line.replace(/\r$/, ''))
    const type = lines
      .find((line) => line.startsWith('event:'))
      ?.slice('event:'.length)
      .trim()
    const payload = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n')
    if (!type || !payload) return
    const data: unknown = JSON.parse(payload)
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('The server returned an invalid build event.')
    }
    const id = lines.find((line) => line.startsWith('id:'))?.slice(3).trim()
    onEvent({ id, type, data: data as Record<string, unknown> })
    if (type === 'complete') complete = true
  }
  try {
    while (!complete) {
      const { done, value } = await reader.read()
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true })
      let separator: RegExpExecArray | null
      while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
        dispatch(buffer.slice(0, separator.index))
        buffer = buffer.slice(separator.index + separator[0].length)
        if (complete) break
      }
      if (done) break
    }
    if (!complete)
      throw new Error(
        'Connection lost before the build result arrived. Reload history to check its status before retrying.',
      )
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Could not read build progress.')
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

export type GeneratedFiles = Array<{ path: string; content: string }>

/** Narrows untrusted event artifacts before the editor accesses them. */
export function isGeneratedFiles(value: unknown): value is GeneratedFiles {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        typeof file === 'object' &&
        file !== null &&
        typeof file.path === 'string' &&
        typeof file.content === 'string',
    )
  )
}
