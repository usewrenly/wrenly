/**
 * Native account profile input policy.
 * Better Auth owns authorization and persistence; this schema permits only bounded display-name updates.
 * Picture uploads use their separate authenticated normalization/storage boundary, never an arbitrary remote image URL.
 */
import { z } from "zod";
const MAX_DISPLAY_NAME_LENGTH = 100;
export const ProfileUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH) })
  .strict();
