type LogContext = Record<string, unknown>

function write(level: string, message: string, context: LogContext): void {
  const fields = Object.fromEntries(
    Object.entries(context).map(([key, value]) => [
      key,
      value instanceof Error
        ? { name: value.name, message: value.message }
        : value,
    ]),
  )
  process.stderr.write(`${JSON.stringify({ level, message, ...fields })}\n`)
}

export const logger = {
  error(message: string, context: LogContext = {}): void {
    write('error', message, context)
  },
  info(message: string, context: LogContext = {}): void {
    write('info', message, context)
  },
}
