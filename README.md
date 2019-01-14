# deno-task-runner

[![Build Status](https://travis-ci.org/jinjor/deno-task-runner.svg?branch=master)](https://travis-ci.org/jinjor/deno-task-runner)
[![Build status](https://ci.appveyor.com/api/projects/status/6kbm7dxgsk7x6wl0?svg=true)](https://ci.appveyor.com/project/jinjor/deno-task-runner)

Write tasks in deno.

## Example

```typescript
import { task } from "https://deno.land/x/task_runner/mod.ts";

task("prepare", "echo preparing...");
task("counter", "deno counter.ts");
task("thumb", "deno https://deno.land/thumb.ts");
task("all", "$prepare", ["$counter alice", "$counter bob"], "$thumb");
//          ^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^
//          1st task    2nd task (parallel)                 3rd task
```

```
$ deno example.ts all --allow-run
preparing...
bob 1
alice 1
alice 2
bob 2
alice 3
bob 3
alice 4
bob 4
bob 5
alice 5
👍
```

## Watch

```typescript
task("compile", "echo changed", "$all").watchSync("src");
task("dev-server", "echo restarting...", "$server").watch("server");
```

## LICENSE

MIT
