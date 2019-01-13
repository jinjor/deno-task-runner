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
  run(context: RunContext): Promise<void>;
}
class Single implements Command {
  constructor(
    public name: string,
    public args: string[],
    public input: string,
    public output: string
  ) {}
  async run({ cwd, resources }: RunContext) {
    let p: Process;
    try {
      const stdout = this.output ? "piped" : "inherit";
      p = deno.run({
        args: [this.name, ...this.args],
        cwd: cwd,
        stdout: stdout,
        stderr: "inherit"
      });
      if (stdout === "piped") {
        const outputFile = await deno.open(
          path.resolve(cwd, this.output),
          "w+"
        );
        await deno.copy(outputFile, p.stdout);
      }
    } catch (e) {
      if (e instanceof DenoError && e.kind === ErrorKind.NotFound) {
        throw new Error(`Command "${this.name}" not found.`);
      }
      throw e;
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

class Ref implements Command {
  constructor(
    public name: string,
    public args: string[],
    public input: string,
    public output: string
  ) {}
  async run(context: RunContext) {
    throw new Error("Ref should be resolved before running.");
  }
}
class Sequence implements Command {
  constructor(public commands: Command[]) {}
  async run(context: RunContext) {
    for (let command of this.commands) {
      await command.run(context);
    }
  }
}
class Parallel implements Command {
  constructor(public commands: Command[]) {}
  async run(context: RunContext) {
    await Promise.all(this.commands.map(c => c.run(context)));
  }
}
class SyncWatcher implements Command {
  constructor(
    public dirs: string[],
    public watchOptions: WatchOptions,
    public command: Command
  ) {}
  async run(context: RunContext) {
    const dirs_ = this.dirs.map(d => {
      return path.join(context.cwd, d);
    });
    const childResources = new Set();
    await this.command
      .run({ ...context, resources: childResources })
      .catch(_ => {});
    for await (const _ of watch(dirs_, this.watchOptions)) {
      closeResouces(childResources);
      await this.command
        .run({ ...context, resources: childResources })
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
  async run(context: RunContext) {
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
    this.command.run({ ...context, resources: childResources }).catch(_ => {});
    for await (const _ of watch(dirs_, this.watchOptions)) {
      closeResouces(childResources);
      this.command
        .run({ ...context, resources: childResources })
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
  cwd: string;
  resources: Set<Closer>;
}
export class TaskRunner {
  tasks: Tasks = {};
  task(name: string, ...rawCommands: (string | string[])[]): TaskDecorator {
    if (name.split(/\s/).length > 1) {
      throw new Error(`Task name "${name}" is invalid.`);
    }
    if (this.tasks[name]) {
      throw new Error(`Task name "${name}" is duplicated.`);
    }
    this.tasks[name] = makeCommand(rawCommands);
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
    await command.run(context);
  }
}

function makeCommand(rawCommands: (string | string[])[]): Command {
  if (rawCommands.length === 0) {
    throw new Error("Task needs at least one command.");
  }
  if (rawCommands.length === 1) {
    return makeNonSequenceCommand(rawCommands[0]);
  }
  return new Sequence(rawCommands.map(makeNonSequenceCommand));
}
function makeNonSequenceCommand(rawCommand: string | string[]): Command {
  if (typeof rawCommand === "string") {
    return makeSingleCommand(rawCommand);
  }
  return new Parallel(rawCommand.map(makeSingleCommand));
}
function makeSingleCommand(raw: string): Command {
  const ast = parse(raw);
  return makeCommandFromAST(ast);
}

function makeCommandFromAST(ast: AST.Sequence): Command {
  if (ast instanceof Leaf) {
    return makeCommandFromASTParallel(ast.value);
  }
  const left = makeCommandFromAST(ast.left);
  const right = makeCommandFromASTParallel(ast.right);
  return new Sequence([left, right]);
}
function makeCommandFromASTParallel(ast: AST.Parallel): Command {
  if (ast instanceof Leaf) {
    return makeCommandFromASTCommand(ast.value);
  }
  const left = makeCommandFromASTParallel(ast.left);
  const right = makeCommandFromASTCommand(ast.right);
  return new Parallel([left, right]);
}
function makeCommandFromASTCommand(ast: AST.Command): Command {
  const splitted = ast.command.split(/\s/);
  if (!splitted.length) {
    throw new Error("Command should not be empty.");
  }
  const name = splitted[0];
  const args = splitted.splice(1);
  if (name.charAt(0) === "$") {
    const taskName = name.slice(1);
    if (!taskName.length) {
      throw new Error("Task name should not be empty.");
    }
    return new Ref(taskName, args, ast.input, ast.output);
  }
  return new Single(name, args, ast.input, ast.output);
}
