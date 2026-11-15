/** Keeps proxy HTML/plain-text failures out of the source UI while retaining definite HTTP status. */
export class SourceResponseError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SourceResponseError";
  }
}
/** An invalid response is not an acknowledgement; callers retain any saved confirmation identity. */
export async function readSourceResponse(response: Response): Promise<unknown> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new SourceResponseError(
      response.status >= 500 ? response.status : 502,
      "Wrenly could not read the server response. Check the API terminal and try again. Your source has not been replaced.",
    );
  }
  if (!response.ok) {
    const message =
      value !== null &&
      typeof value === "object" &&
      "error" in value &&
      typeof value.error === "string"
        ? value.error.slice(0, 1000)
        : "The source request could not be completed. Try again shortly.";
    throw new SourceResponseError(response.status, message);
  }
  return value;
}
