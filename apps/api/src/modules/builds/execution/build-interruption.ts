/** An unresolved external effect must stop repair attempts and remain explicitly recoverable. */
export class BuildExecutionInterruptedError extends Error {
  constructor() {
    super(
      "Build validation needs recovery. Review its saved database operation before retrying.",
    );
    this.name = "BuildExecutionInterruptedError";
  }
}
