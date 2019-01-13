import { ProcessStatus, Closer, DenoError, ErrorKind, Process } from "deno";
import * as deno from "deno";
import {
  watch,
  Options as WatchOptions
} from "https://deno.land/x/watch@1.2.0/mod.ts";
import * as path from "https://deno.land/x/path@v0.2.5/index.ts";
import { parse, AST, Leaf } from "parser.ts";

type Tasks = { [name: string]: Command };
class ProcessError extends Error {
  constructor(
    public pid: number,
    public rid: number,
    public status: ProcessStatus,
    public taskName?: string
  ) {
    super("Process exited with status code " + status.code);
  }
}
interface Command {
  run(args: string[], ontext: RunContext): Promise<void>;
}
class Atom implements Command {
  constructor(
    public args: string[],
    public input: string,
    public output: string
  ) {}
  async run(args: string[], { taskFile, cwd, resources }: RunContext) {
    const stdout = this.output ? "piped" : "inherit";
    let p: Process;
    if (this.args[0].charAt(0) === "$") {
      // Run another task
      const name = this.args[0];
      const rest = this.args.slice(1);
      const taskName = name.slice(1);
      if (!taskName.length) {
        throw new Error("Task name should not be empty.");
      }
      p = deno.run({
        args: [
          "deno",
          "--allow-run",
          taskFile,
          `--cwd=${cwd}`,
          taskName,
          ...rest,
          ...args
        ],
        stdout: stdout,
        stderr: "inherit"
      });
    } else {
      p = deno.run({
        args: [...this.args, ...args],
        cwd: cwd,
        stdout: stdout,
        stderr: "inherit"
      });
    }
    if (stdout === "piped") {
      const outputFile = await deno.open(path.resolve(cwd, this.output), "w+");
      await deno.copy(outputFile, p.stdout);
    }
    const closer = {
      close() {
        kill(p);
      }
    };
    resources.add(closer);
    const status = await p.status();
    p.close();
    resources.delete(closer);
    if (!status.success) {
      throw new ProcessError(p.pid, p.rid, status);
    }
  }
}
async function kill(p: Process) {
  const k = deno.run({
    args: ["kill", `${p.pid}`],
    stdout: "inherit",
    stderr: "inherit"
  });
  await k.status();
  k.close();
}
class Sequence implements Command {
  constructor(
    public prev: Command,
    public curr: Command,
    public op: AST.SequenceOp
  ) {}
  async run(args: string[], context: RunContext): Promise<void> {
    if (args.length) {
      throw new Error("Cannot pass args to sequential tasks.");
    }
    await this.prev.run([], context).catch(e => {
      if (this.op === "&&") {
        return Promise.reject();
      }
    });
    await this.curr.run([], context);
  }
}

class Parallel implements Command {
  constructor(
    public prev: Command,
    public curr: Command,
    public op: AST.ParallelOp
  ) {}
  async run(args: string[], context: RunContext): Promise<void> {
    if (args.length) {
      throw new Error("Cannot pass args to parallel tasks.");
    }
    await Promise.all([this.prev.run([], context), this.curr.run([], context)]);
  }
}
class SyncWatcher implements Command {
  constructor(
    public dirs: string[],
    public watchOptions: WatchOptions,
    public command: Command
  ) {}
  async run(args: string[], context: RunContext): Promise<void> {
    const dirs_ = this.dirs.map(d => {
      return path.join(context.cwd, d);
    });
    const childResources = new Set();
    await this.command
      .run(args, { ...context, resources: childResources })
      .catch(_ => {});
    for await (const _ of watch(dirs_, this.watchOptions)) {
      closeResouces(childResources);
      await this.command
        .run(args, { ...context, resources: childResources })
        .catch(_ => {});
    }
  }
}
class AsyncWatcher implements Command {
  constructor(
    public dirs: string[],
    public watchOptions: WatchOptions,
    public command: Command
  ) {}
  async run(args: string[], context: RunContext): Promise<void> {
    const dirs_ = this.dirs.map(d => {
      return path.join(context.cwd, d);
    });
    const childResources = new Set();
    const closer = {
      close() {
        throw new Error("Nested watchers not supported.");
      }
    };
    context.resources.add(closer);
    await this.command
      .run(args, { ...context, resources: childResources })
      .catch(_ => {});
    for await (const _ of watch(dirs_, this.watchOptions)) {
      closeResouces(childResources);
      this.command
        .run(args, { ...context, resources: childResources })
        .catch(_ => {});
    }
    context.resources.delete(closer);
  }
}

function closeResouces(resources: Set<Closer>) {
  for (let resource of resources) {
    resource.close();
  }
  resources.clear();
}

export class TaskDecorator {
  constructor(public tasks: Tasks, public name: string) {}
  watchSync(dirs: string | string[], watchOptions = {}) {
    if (typeof dirs === "string") {
      dirs = [dirs];
    }
    this.tasks[this.name] = new SyncWatcher(
      dirs,
      watchOptions,
      this.tasks[this.name]
    );
  }
  watch(dirs: string | string[], watchOptions = {}) {
    if (typeof dirs === "string") {
      dirs = [dirs];
    }
    this.tasks[this.name] = new AsyncWatcher(
      dirs,
      watchOptions,
      this.tasks[this.name]
    );
  }
}
interface RunOptions {
  taskFile: string;
  cwd?: string;
}
interface RunContext {
  taskFile: string;
  cwd: string;
  resources: Set<Closer>;
}
export class TaskRunner {
  tasks: Tasks = {};
  task(name: string, rawCommand: string): TaskDecorator {
    if (name.split(/\s/).length > 1) {
      throw new Error(`Task name "${name}" is invalid.`);
    }
    if (this.tasks[name]) {
      throw new Error(`Task name "${name}" is duplicated.`);
    }
    const ast = parse(rawCommand);
    this.tasks[name] = makeSequence(ast);
    return new TaskDecorator(this.tasks, name);
  }
  async run(taskName: string, args: string[] = [], options: RunOptions) {
    options = { cwd: ".", ...options };
    let command = this.tasks[taskName];
    if (!command) {
      throw new Error(`Task "${taskName}" not found.`);
    }
    const context = {
      taskFile: options.taskFile,
      cwd: options.cwd,
      resources: new Set()
    };
    await command.run(args, context);
  }
}

function makeSequence(ast: AST.Sequence): Command {
  if (ast instanceof Leaf) {
    return makeParallel(ast.value);
  }
  const left = makeSequence(ast.left);
  const right = makeParallel(ast.right);
  return new Sequence(left, right, ast.op as any);
}
function makeParallel(ast: AST.Parallel): Command {
  if (ast instanceof Leaf) {
    return makeAtom(ast.value);
  }
  const left = makeParallel(ast.left);
  const right = makeAtom(ast.right);
  return new Parallel(left, right, ast.op as any);
}
function makeAtom(ast: AST.Command): Command {
  const args = ast.command.split(/\s/);
  if (!args.length) {
    throw new Error("Command should not be empty.");
  }
  return new Atom(args, ast.input, ast.output);
}
