import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import {
  PromptCancelledError,
  confirmPrompt,
  multiselectPrompt,
  selectPrompt,
  textPrompt,
  type PromptIO,
} from "../src/prompts";

function createFakeIo(): {
  io: PromptIO;
  input: PassThrough;
  rawCalls: boolean[];
  getOutput: () => string;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  const rawCalls: boolean[] = [];
  input.isTTY = true;
  input.setRawMode = (mode: boolean) => {
    rawCalls.push(mode);
  };
  let output = "";
  return {
    io: {
      input,
      output: {
        columns: 80,
        write: (text: string) => {
          output += text;
        },
      },
    },
    input,
    rawCalls,
    getOutput: () => output,
  };
}

function sendKeys(stream: PassThrough, sequence: string[]): void {
  queueMicrotask(async () => {
    for (const key of sequence) {
      stream.write(key);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  });
}

test("selectPrompt navigates with arrow keys and restores cursor and raw mode", async () => {
  const fake = createFakeIo();
  const promise = selectPrompt(
    {
      message: "Choose preset",
      options: [
        { value: "first", label: "First" },
        { value: "second", label: "Second" },
        { value: "third", label: "Third" },
      ],
    },
    fake.io,
    true,
  );
  sendKeys(fake.input, ["\u001b[B", "\u001b[B", "\r"]);
  expect(await promise).toBe("third");
  expect(fake.rawCalls).toEqual([true, false]);
  expect(fake.getOutput()).toContain("\u001b[?25h");
});

test("multiselectPrompt toggles individual items with space and toggles all with 'a'", async () => {
  const fake1 = createFakeIo();
  const p1 = multiselectPrompt(
    {
      message: "Select items",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
        { value: "c", label: "C" },
      ],
    },
    fake1.io,
    false,
  );
  sendKeys(fake1.input, [" ", "\u001b[B", " ", "\r"]);
  expect(await p1).toEqual(["a", "b"]);

  const fake2 = createFakeIo();
  const p2 = multiselectPrompt(
    {
      message: "Select all",
      options: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
      ],
    },
    fake2.io,
    false,
  );
  sendKeys(fake2.input, ["a", "\r"]);
  expect(await p2).toEqual(["x", "y"]);

  const fake3 = createFakeIo();
  const p3 = multiselectPrompt(
    {
      message: "Toggle all off",
      initial: ["x"],
      options: [
        { value: "x", label: "X" },
        { value: "y", label: "Y" },
      ],
    },
    fake3.io,
    false,
  );
  sendKeys(fake3.input, ["a", "a", "\r"]);
  expect(await p3).toEqual([]);
});

test("textPrompt supports typing, backspace, inline validation error and retry", async () => {
  const fake = createFakeIo();
  const promise = textPrompt(
    {
      message: "Folder",
      initial: "/tmp/ab",
      validate: (value) =>
        value.startsWith("/tmp/ok") ? undefined : "Must start with /tmp/ok",
    },
    fake.io,
    false,
  );
  sendKeys(fake.input, [
    "\r",
    "\u007f",
    "\u007f",
    "o",
    "k",
    "1",
    "\r",
  ]);
  expect(await promise).toBe("/tmp/ok1");
  expect(fake.getOutput()).toContain("Must start with /tmp/ok");
  expect(fake.getOutput()).toContain("\u001b[?25h");
});

test("textPrompt placeholder accepts Enter, replaces on first keystroke, and edits on Backspace", async () => {
  const f1 = createFakeIo();
  const p1 = textPrompt(
    { message: "Folder", placeholder: "/home/user/wrenly" },
    f1.io,
    false,
  );
  sendKeys(f1.input, ["\r"]);
  expect(await p1).toBe("/home/user/wrenly");
  expect(f1.getOutput()).toContain("▌/home/user/wrenly");

  const f2 = createFakeIo();
  const p2 = textPrompt(
    { message: "Folder", placeholder: "/home/user/wrenly" },
    f2.io,
    false,
  );
  sendKeys(f2.input, ["./app", "\r"]);
  expect(await p2).toBe("./app");

  const f3 = createFakeIo();
  const p3 = textPrompt(
    { message: "Folder", placeholder: "/home/user/ab" },
    f3.io,
    false,
  );
  sendKeys(f3.input, ["\u007f", "c", "\r"]);
  expect(await p3).toBe("/home/user/ac");
});

test("confirmPrompt toggles with left arrow and submits boolean", async () => {
  const fake = createFakeIo();
  const promise = confirmPrompt(
    { message: "Proceed?", initial: true },
    fake.io,
    false,
  );
  sendKeys(fake.input, ["\u001b[D", "\r"]);
  expect(await promise).toBe(false);
});

test("Ctrl+C rejects with PromptCancelledError and restores raw mode and cursor", async () => {
  const fake = createFakeIo();
  const promise = textPrompt(
    { message: "Folder", initial: "/tmp/wrenly" },
    fake.io,
    true,
  );
  sendKeys(fake.input, ["\u0003"]);
  await expect(promise).rejects.toThrow(PromptCancelledError);
  expect(fake.rawCalls).toEqual([true, false]);
  expect(fake.getOutput()).toContain("\u001b[?25h");
});
