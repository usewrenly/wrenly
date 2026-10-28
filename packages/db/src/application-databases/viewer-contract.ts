/** Pure viewer types and bounds shared by trusted queries and authorized HTTP responses.
 * No database client, environment loading, SQL or row data is imported here.
 */
import { z } from "zod";
import { DatabaseEnvironment } from "./action-contract";
export interface DatabaseViewerColumn {
  name: string;
  type: string;
  nullable: boolean;
  supported: boolean;
  primary: boolean;
}
export interface DatabaseViewerResult {
  tables: string[];
  table: string | null;
  columns: DatabaseViewerColumn[];
  rows: Array<Array<string | null>>;
  sample: boolean;
  nextKey: string | null;
  truncatedColumns: boolean;
}
export const DATABASE_VIEW_LIMITS = {
  maxTables: 128,
  maxColumns: 32,
  maxRows: 50,
  maxResponseBytes: 128 * 1024,
  maxCursorBytes: 1024,
  maxIdentifierBytes: 63,
  maxTypeNameCharacters: 256,
} as const;

export const DatabaseViewerResultSchema: z.ZodType<DatabaseViewerResult> = z
  .object({
    tables: z
      .array(z.string().min(1).max(DATABASE_VIEW_LIMITS.maxIdentifierBytes))
      .max(DATABASE_VIEW_LIMITS.maxTables),
    table: z
      .string()
      .min(1)
      .max(DATABASE_VIEW_LIMITS.maxIdentifierBytes)
      .nullable(),
    columns: z
      .array(
        z
          .object({
            name: z.string().max(DATABASE_VIEW_LIMITS.maxIdentifierBytes),
            type: z.string().max(DATABASE_VIEW_LIMITS.maxTypeNameCharacters),
            nullable: z.boolean(),
            supported: z.boolean(),
            primary: z.boolean(),
          })
          .strict(),
      )
      .max(DATABASE_VIEW_LIMITS.maxColumns),
    rows: z
      .array(
        z.array(z.string().nullable()).max(DATABASE_VIEW_LIMITS.maxColumns),
      )
      .max(DATABASE_VIEW_LIMITS.maxRows),
    sample: z.boolean(),
    nextKey: z.string().max(DATABASE_VIEW_LIMITS.maxCursorBytes).nullable(),
    truncatedColumns: z.boolean(),
  })
  .strict();

/** PostgreSQL identifiers are byte-bounded; TextEncoder keeps these checks usable in the browser too. */
export const DatabaseViewerSelection = z
  .object({
    resourceId: z.string().uuid(),
    revision: z.string().uuid(),
    environment: DatabaseEnvironment,
    rows: z.boolean(),
    table: z
      .string()
      .min(1)
      .max(DATABASE_VIEW_LIMITS.maxIdentifierBytes)
      .refine(
        (value) =>
          !value.includes("\0") &&
          new TextEncoder().encode(value).byteLength <= DATABASE_VIEW_LIMITS.maxIdentifierBytes,
      )
      .optional(),
    after: z
      .string()
      .max(DATABASE_VIEW_LIMITS.maxCursorBytes)
      .refine(
        (value) =>
          new TextEncoder().encode(value).byteLength <= DATABASE_VIEW_LIMITS.maxCursorBytes,
      )
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.rows && !value.table) ||
      (value.after !== undefined && (!value.rows || !value.table))
    )
      context.addIssue({
        code: "custom",
        message: "Select a table before requesting rows or another page.",
      });
  });
export type DatabaseViewerSelection = z.infer<typeof DatabaseViewerSelection>;
