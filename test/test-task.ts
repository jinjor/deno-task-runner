import { task } from "../mod.ts";

// const runner = new TaskRunner();
// runner.task("hello", "echo hello");
// runner.task("hello2", "$hello alice", "$hello bob");
// runner.task("c", "deno count.ts");
// runner.task("count", "$c start", ["$c foo 1 3 5", "$c bar 2 4"], "$c end");
// runner.task("hello-watch", "echo hello").watch(".");
// runner.task("touch", "touch test.ts");
task("hello", "echo hello");
task("hello2", "$hello alice && $hello bob");
task("c", "deno count.ts");
task("count", "$c start && $c foo 1 3 5 & $c bar 2 4 && $c end");
task("hello-watch", "echo hello").watch(".");
task("touch", "touch test.ts");
task("test", "$hello world && echo ==== && $hello2 && echo ==== && $count");
