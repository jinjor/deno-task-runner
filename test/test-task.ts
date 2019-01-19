import { task } from "../mod.ts";

task("hello", "echo hello");
task("hello2", "$hello alice", "$hello bob");
task("123456", "echo 123 && echo 456");
task("c", "deno count.ts");
task("count", "$c start", ["$c foo 1 3 5", "$c bar 2 4"], "$c end");
task("hello-watch", "echo hello").watch(".");
task("touch", "touch test.ts");
task(
  "shell",
  `echo hello > ../tmp/result-from-shell`,
  `echo world >> ../tmp/result-from-shell`,
  `$123456 >> ../tmp/result-from-shell`
);
task(
  "all",
  "$hello world",
  "echo ====",
  "$hello2",
  "echo ====",
  "$count",
  "echo ====",
  "$shell",
  "echo ===="
);
