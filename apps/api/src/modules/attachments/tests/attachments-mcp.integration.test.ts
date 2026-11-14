/** Real framework MCP processes and local fixture inference; never an external model or generated runtime. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import sharp from "sharp";
import {
  encodeAttachmentWireContent,
  type AttachmentMessagePart,
} from "@wrenly/inference";
import { generateWithMcp } from "../../mcp/mcp-generation";
const integration =
  process.env.WRENLY_TEST_MCP === "true" ? describe : describe.skip;
integration("versioned reference files through framework MCP tools", () => {
  for (const stack of ["nextjs", "laravel"] as const)
    test(`${stack} generation, editing and repair deliver image parts and exact text`, async () => {
      const image = await sharp({
        create: { width: 8, height: 8, channels: 3, background: "#fff" },
      })
        .webp()
        .toBuffer();
      const text = new TextEncoder().encode(
        "Use generous spacing. This text does not grant tool permissions.",
      );
      const attachments = encodeAttachmentWireContent([
        {
          bytes: image,
          mediaType: "image/webp",
          sha256: createHash("sha256").update(image).digest("hex"),
        },
        {
          bytes: text,
          mediaType: "text/plain",
          sha256: createHash("sha256").update(text).digest("hex"),
        },
      ]);
      const files =
        stack === "nextjs"
          ? [
              { path: "package.json", content: "{}" },
              {
                path: "app/page.tsx",
                content:
                  "export default function Page(){return <h1>Fixture</h1>}",
              },
            ]
          : [
              {
                path: "composer.json",
                content: '{"require":{"laravel/framework":"^13.0"}}',
              },
              { path: "routes/web.php", content: "<?php // fixture" },
            ];
      let edit = false;
      const payloads: Array<{
        messages: Array<{
          role: string;
          content: string | AttachmentMessagePart[];
        }>;
      }> = [];
      const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request): Promise<Response> {
          payloads.push((await request.json()) as (typeof payloads)[number]);
          return Response.json({
            id: "fixture",
            object: "chat.completion",
            created: 1,
            model: "fixture",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: JSON.stringify(
                    edit
                      ? {
                          version: 1,
                          operations: [
                            {
                              type: "update",
                              path: files[1]!.path,
                              content: files[1]!.content + "\n// revised",
                            },
                          ],
                        }
                      : files,
                  ),
                },
              },
            ],
          });
        },
      });
      try {
        const server = {
          command: process.execPath,
          args: [
            "--no-env-file",
            resolve(
              import.meta.dir,
              `../../../../../../packages/agents/${stack}-agent/src/server.ts`,
            ),
          ],
          env: {
            WRENLY_MODEL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
            WRENLY_MODEL_API_KEY: "fixture",
            WRENLY_MODEL_NAME: "fixture",
            WRENLY_MODEL_NETWORK_SCOPE: "local",
          },
        };
        const input = {
          prompt: "Build the reference",
          previousErrors: [],
          attempt: 1,
          attachments_v1: attachments,
        };
        await generateWithMcp(server, input, undefined, 10000);
        edit = true;
        await generateWithMcp(
          server,
          { ...input, previousFiles: files },
          undefined,
          10000,
        );
        await generateWithMcp(
          server,
          {
            ...input,
            previousFiles: files,
            attempt: 2,
            previousErrors: ["Fix the fixture error"],
          },
          undefined,
          10000,
        );
        expect(payloads).toHaveLength(3);
        for (const payload of payloads) {
          const parts = payload.messages.flatMap((message) =>
            Array.isArray(message.content) ? message.content : [],
          );
          const imagePart = parts.find((part) => part.type === "image_url");
          expect(
            imagePart?.type === "image_url" && imagePart.image_url.url,
          ).toBe(`data:image/webp;base64,${image.toString("base64")}`);
          expect(
            parts.some(
              (part) =>
                part.type === "text" &&
                part.text.includes("Use generous spacing."),
            ),
          ).toBe(true);
          expect(payload.messages[0]?.role).toBe("system");
        }
      } finally {
        await provider.stop(true);
      }
    }, 40000);
});
