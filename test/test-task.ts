import { TaskRunner } from "../runner.ts";

const runner = new TaskRunner();
runner.task("hello", "echo hello");
runner.task("hello2", "$hello alice", "$hello bob");
runner.task("c", "deno count.ts");
runner.task("count", "$c start", ["$c foo 1 3 5", "$c bar 2 4"], "$c end");
runner.task("hello-watch", "echo hello").watch(".");
runner.task("touch", "touch test.ts");
runner.task(
  "shell",
  `echo hello > ../tmp/result-from-shell`,
  `echo world >> ../tmp/result-from-shell`
);

(async () => {
  await runner.run("hello", ["world"], { cwd: "test" });
  console.log("====");
  await runner.run("hello2", [], { cwd: "test" });
  console.log("====");
  await runner.run("count", [], { cwd: "test" });
  console.log("====");
  await runner.run("shell", [], { cwd: "test" });
  // console.log("====");
  // await runner.run("hello-watch", [],{ cwd: "test" });
  // await new Promise(resolve => setTimeout(resolve, 1000));
  // await runner.run("touch", [],{ cwd: "test" });
})();
