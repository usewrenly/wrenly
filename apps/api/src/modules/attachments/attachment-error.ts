/** Safe attachment failures shared by HTTP and persistence without opening a database. */
export class AttachmentStoreError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentStoreError";
  }
}
