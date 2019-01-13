import { ProcessStatus, Closer, DenoError, ErrorKind, Process } from "deno";
import * as deno from "deno";
import {
  watch,
  Options as WatchOptions
} from "https://deno.land/x/watch@1.2.0/mod.ts";
import * as path from "https://deno.land/x/path@v0.2.5/index.ts";
import { parse, AST, Leaf } from "parser.ts";

type Tasks = { [name: string]: Command };
interface ResolveContext {
  checked: Set<string>;
  hasWatcher: boolean;
}
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
  resolveRef(tasks: Tasks, context: ResolveContext): Command;
  run(args: string[], context: RunContext): Promise<void>;
}
class Single implements Command {
  constructor(public name: string, public args: string[]) {}
  resolveRef(tasks: Tasks, _: ResolveContext) {
    return this;
  }
  async run(args: string[], { cwd, resources }: RunContext) {
    let p: Process;
    try {
      p = deno.run({
        args: [this.name, ...this.args, ...args],
        cwd: cwd,
        stdout: "inherit",
        stderr: "inherit"
      });
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
  constructor(public name: string, public args: string[]) {}
  resolveRef(tasks: Tasks, context: ResolveContext) {
    let command = tasks[this.name];
    if (!command) {
      throw new Error(`Task "${this.name}" is not defined.`);
    }
    if (context.checked.has(this.name)) {
      throw new Error(`Task "${this.name}" is in a reference loop.`);
    }
    if (command instanceof Single) {
      command = new Single(command.name, command.args.concat(this.args));
    }
    return command.resolveRef(tasks, {
      ...context,
      checked: new Set(context.checked).add(this.name)
    });
  }
  async run(args: string[], context: RunContext) {
    throw new Error("Ref should be resolved before running.");
  }
}
class Sequence implements Command {
  commands: Command[];
  constructor(commands: Command[]) {
    this.commands = commands;
  }
  resolveRef(tasks: Tasks, context: ResolveContext) {
    return new Sequence(
      this.commands.map(c => {
        return c.resolveRef(tasks, context);
      })
    );
  }
  async run(args: string[], context: RunContext) {
    if (args.length) {
      throw new Error("Cannot pass args to sequential tasks.");
    }
    for (let command of this.commands) {
      await command.run([], context);
    }
  }
}
class Parallel implements Command {
  commands: Command[];
  constructor(commands: Command[]) {
    this.commands = commands;
  }
  resolveRef(tasks: Tasks, context: ResolveContext) {
    return new Parallel(
      this.commands.map(c => {
        return c.resolveRef(tasks, context);
      })
    );
  }
  async run(args: string[], context: RunContext) {
    if (args.length) {
      throw new Error("Cannot pass args to parallel tasks.");
    }
    await Promise.all(this.commands.map(c => c.run([], context)));
  }
}
class SyncWatcher implements Command {
  constructor(
    public dirs: string[],
    public watchOptions: WatchOptions,
    public command: Command
  ) {}
  resolveRef(tasks: Tasks, context: ResolveContext) {
    if (context.hasWatcher) {
      throw new Error("Nested watchers not supported.");
    }
    return new SyncWatcher(
      this.dirs,
      this.watchOptions,
      this.command.resolveRef(tasks, { ...context, hasWatcher: true })
    );
  }
  async run(args: string[], context: RunContext) {
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
  resolveRef(tasks: Tasks, context: ResolveContext) {
    if (context.hasWatcher) {
      throw new Error("Nested watchers not supported.");
    }
    return new AsyncWatcher(
      this.dirs,
      this.watchOptions,
      this.command.resolveRef(tasks, { ...context, hasWatcher: true })
    );
  }
  async run(args: string[], context: RunContext) {
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
    this.command
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
  async run(taskName: string, args: string[] = [], options: RunOptions = {}) {
    options = { cwd: ".", ...options };
    let command = this.tasks[taskName];
    if (!command) {
      throw new Error(`Task "${taskName}" not found.`);
    }
    const resolveContext = { checked: new Set(), hasWatcher: false };
    const context = {
      cwd: options.cwd,
      resources: new Set()
    };
    const resolvedCommand = command.resolveRef(this.tasks, resolveContext);
    await resolvedCommand.run(args, context);
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
    return new Ref(taskName, args);
  }
  return new Single(name, args);
}
