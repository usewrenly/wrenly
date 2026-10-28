import { describe, expect, test } from 'bun:test'
import {
  readBuildEvents,
  isGeneratedFiles,
  type BuildEvent,
} from '../../build-events'

function stream(text: string, chunkSize = 1): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller): void {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize))
      }
      controller.close()
    },
  })
}

describe('build event transport', () => {
  test('reads CRLF frames and UTF-8 split across individual bytes', async () => {
    const events: BuildEvent[] = []
    await readBuildEvents(
      stream(
        ': heartbeat\r\n\r\nevent: log_line\r\ndata: {"line":"✓ built"}\r\n\r\nevent: complete\r\ndata: {"success":true}\r\n\r\n',
      ),
      (event) => {
        events.push(event)
      },
    )
    expect(events.map((event) => event.type)).toEqual(['log_line', 'complete'])
    expect(events[0]?.data.line).toBe('✓ built')
  })

  test('rejects EOF without a complete event rather than leaving a build busy', async () => {
    await expect(
      readBuildEvents(
        stream('event: status\ndata: {"phase":"building"}\n\n'),
        () => {},
      ),
    ).rejects.toThrow('Connection lost')
  })

  test('does not accept a truncated terminal frame', async () => {
    await expect(
      readBuildEvents(
        stream('event: complete\ndata: {"success":true}'),
        () => {},
      ),
    ).rejects.toThrow('Connection lost')
  })

  test('rejects malformed payloads and propagates consumer validation failures', async () => {
    await expect(
      readBuildEvents(stream('event: complete\ndata: []\n\n'), () => {}),
    ).rejects.toThrow('invalid build event')
    await expect(
      readBuildEvents(stream('event: complete\ndata: {}\n\n'), () => {
        throw new Error('Invalid result')
      }),
    ).rejects.toThrow('Invalid result')
  })

  test('only accepts file entries with string paths and content', () => {
    expect(isGeneratedFiles([{ path: 'app/page.tsx', content: '' }])).toBe(true)
    expect(isGeneratedFiles([{ path: 'app/page.tsx', content: null }])).toBe(
      false,
    )
    expect(isGeneratedFiles(null)).toBe(false)
  })
})
