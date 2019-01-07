import { readFile } from "deno";
import { test } from "https://deno.land/x/testing/mod.ts";
import { assertEqual } from "https://deno.land/x/pretty_assert@0.1.3/mod.ts";
import { TaskRunner } from "../runner.ts";

test(async function basics() {
  const bytes = await readFile("tmp/result");
  const result = new TextDecoder().decode(bytes).trim();
  assertEqual(result, expectation);
});

const expectation = `
hello world
====
hello alice
hello bob
====
start
foo
bar
foo
bar
foo
end
`.trim();

test(async function errors() {
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("foo");
  });
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("a b", "echo hello");
  });
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("hello", "echo hello");
    runner.task("hello", "echo hello again");
  });
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("hello", "echo hello");
    await runner.run("hell");
  });
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("hello", "$echo hello");
    await runner.run("hello");
  });
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("hello", "$hello");
    await runner.run("hello");
  });
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("greeting", "echo hello", "echo bye");
    await runner.run("greeting", ["x"]);
  });
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("greeting", ["echo hello", "echo bye"]);
    await runner.run("greeting", ["x"]);
  });
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("child", ["echo hello"]).watch(".");
    runner.task("parent", ["$child"]).watch(".");
    await runner.run("parent", []);
  });
});

export async function throws(
  f: () => Promise<void> | void,
  message?: string
): Promise<void> {
  let thrown = false;
  try {
    await f();
  } catch (e) {
    console.log(e.message);
    thrown = true;
  }
  if (!thrown) {
    throw new Error(
      message || `Expected \`${funcToString(f)}\` to throw, but it did not.`
    );
  }
}
function funcToString(f: Function) {
  // index_ts_1.funcname()
  return f
    .toString()
    .replace(/[a-zA-Z0-9]+_(ts|js)_[0-9]+\./g, "")
    .replace(/\s+/g, " ");
}
