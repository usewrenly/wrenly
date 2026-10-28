import { expect, test } from "bun:test";
import { ProfileUpdateSchema } from "../../profile/profile-policy";
test("profile updates allow only a bounded canonical display name", () => {
  expect(ProfileUpdateSchema.parse({ name: "  James  " })).toEqual({
    name: "James",
  });
  for (const body of [
    { name: " " },
    { name: "x".repeat(101) },
    { name: 12 },
    { name: "James", email: "other@example.test" },
    { name: "James", role: "owner" },
    { name: "James", image: "https://tracker.invalid/avatar" },
    { name: "James", id: "another-user" },
  ])
    expect(ProfileUpdateSchema.safeParse(body).success).toBe(false);
});
