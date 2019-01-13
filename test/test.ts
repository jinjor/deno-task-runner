import { readFile, inspect } from "deno";
import { test } from "https://deno.land/x/testing@v0.2.5/mod.ts";
import { assertEqual } from "https://deno.land/x/pretty_assert@0.1.4/mod.ts";
import { TaskRunner } from "../runner.ts";
import { parse } from "../parser.ts";

test(async function parser() {
  const input1 = "a 1 && b 2 | c 3 > d 4 < e 5 & f 6 || g 7";
  const input2 = " a 1&&b 2|c 3<e 5>???>d 4&f 6||g 7 ";
  assertEqual(parse(input1), parse(input2));
  await throws(async () => {
    parse("");
  });
  const ops = ["<", ">", "&", "|", "&&", "||"];
  for (let s of [
    ...ops,
    ...ops.map(op => `a ${op}`),
    ...ops.map(op => `a${op}`),
    ...ops.map(op => `${op} b`),
    ...ops.map(op => `${op}b`),
    ...ops.map(op => `a ${op} ${op} b`),
    ...ops.map(op => `a${op} ${op}b`)
  ]) {
    await throws(() => {
      parse(s);
    });
  }
  // unsupported for now
  for (let s of ["a >> b", "a |& b"]) {
    await throws(() => {
      parse(s);
    });
  }
});

test(async function basics() {
  const bytes = await readFile("tmp/result");
  const result = new TextDecoder()
    .decode(bytes)
    .replace(/\r\n/g, "\n")
    .trim();

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
====
`
  .replace(/\r\n/g, "\n")
  .trim();

test(async function errors() {
  await throws(async () => {
    const runner = new TaskRunner();
    runner.task("foo", "");
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
  // await throws(async () => {
  //   const runner = new TaskRunner();
  //   runner.task("hello", "echo hello");
  //   await runner.run("hell", []);
  // });
  // await throws(async () => {
  //   const runner = new TaskRunner();
  //   runner.task("hello", "$echo hello");
  //   await runner.run("hello");
  // });
  // await throws(async () => {
  //   const runner = new TaskRunner();
  //   runner.task("hello", "$hello");
  //   await runner.run("hello");
  // });
  // await throws(async () => {
  //   const runner = new TaskRunner();
  //   runner.task("greeting", "echo hello", "echo bye");
  //   await runner.run("greeting", ["x"]);
  // });
  // await throws(async () => {
  //   const runner = new TaskRunner();
  //   runner.task("greeting", ["echo hello", "echo bye"]);
  //   await runner.run("greeting", ["x"]);
  // });
  // await throws(async () => {
  //   const runner = new TaskRunner();
  //   runner.task("child", ["echo hello"]).watch(".");
  //   runner.task("parent", ["$child"]).watch(".");
  //   await runner.run("parent", []);
  // });
  // await throws(async () => {
  //   const runner = new TaskRunner();
  //   runner.task(
  //     "failure",
  //     "echo start",
  //     ["deno test/failure.ts", "echo another"],
  //     "echo end"
  //   );
  //   await runner.run("failure");
  // });
});

// Utilities

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
