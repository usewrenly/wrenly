import { expect, test } from "bun:test";
import { MediaOrigins } from "../../media/preview-media-contract";
test("preview media accepts exact reviewed HTTPS origins and refuses retargeting or CSP injection", () => {
  expect(MediaOrigins.parse(["https://images.unsplash.com"])).toEqual([
    "https://images.unsplash.com",
  ]);
  expect(MediaOrigins.parse(["https://cdn.example.com"])).toEqual(["https://cdn.example.com"]);
  for (const origin of [
    "https:",
    "*",
    "https://images.unsplash.com/",
    "http://images.unsplash.com",
    "https://images.unsplash.com.evil.invalid",
    "https://127.0.0.1",
    "https://localhost",
    "https://media.local",
    "https://media.example.com:8443",
    "https://[::1]",
    "https://2130706433",
    "https://media.example.com/file.png",
    "https://media.example.com?x=1",
    "https://user:password@images.unsplash.com",
    "https://images.unsplash.com; script-src *",
  ])
    expect(MediaOrigins.safeParse([origin]).success).toBe(false);
  expect(
    MediaOrigins.safeParse([
      "https://images.unsplash.com",
      "https://images.unsplash.com",
    ]).success,
  ).toBe(false);
});
