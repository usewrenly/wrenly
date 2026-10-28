/**
 * Project-scoped author presentation.
 * Call only after authorizing the enclosing project; returns bounded display metadata and authenticated picture routes rather than credential/account records.
 */
import { inArray } from "drizzle-orm";
import type { db } from "@wrenly/db";
import { user, profilePictures } from "@wrenly/db";
import { eq } from "drizzle-orm";
export interface ProjectAuthor {
  id: string;
  name: string;
  pictureUrl: string | null;
}
/** Resolves names and canonical local images; emails and account internals never enter history. */
export async function getProjectAuthors(
  database: typeof db,
  ids: string[],
): Promise<Map<string, ProjectAuthor>> {
  try {
    if (!ids.length) return new Map();
    const rows = await database
      .select({
        id: user.id,
        name: user.name,
        revision: profilePictures.revision,
        bytes: profilePictures.imageBase64,
      })
      .from(user)
      .leftJoin(profilePictures, eq(profilePictures.userId, user.id))
      .where(inArray(user.id, [...new Set(ids)]));
    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          name: row.name,
          pictureUrl:
            row.revision && row.bytes
              ? `/api/account/profile-picture/image?userId=${encodeURIComponent(row.id)}&revision=${row.revision}`
              : null,
        },
      ]),
    );
  } catch (error) {
    throw new Error("Project authors could not be loaded.", { cause: error });
  }
}
