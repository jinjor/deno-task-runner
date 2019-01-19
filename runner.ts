import { ProcessStatus, Closer, Process } from "deno";
import * as deno from "deno";
import {
  watch,
  Options as WatchOptions
} from "https://deno.land/x/watch@1.2.0/mod.ts";
import * as path from "https://deno.land/x/fs/path.ts"; // should fix later

type Tasks = { [name: string]: Command };
interface ValidateContext {
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
  validate(tasks: Tasks, context: ValidateContext): void;
  run(args: string[], context: RunContext): Promise<void>;
}
class Single implements Command {
  constructor(public script: string) {}
  validate(tasks: Tasks, _: ValidateContext) {}
  async run(
    args: string[],
    { taskFile, cwd, tasks, shell, resources }: RunContext
  ) {
    let script = this.script;
    for (let taskName of Object.keys(tasks)) {
      const regex = new RegExp(`\\$${taskName}`, "g");
      script = script.replace(
        regex,
        `deno -A ${path.relative(cwd, taskFile)} ${taskName}`
      );
    }
    const allArgs = shell
      ? [...getShellCommand(), [script, ...args].join(" ")]
      : [...this.script.split(/\s/), ...args];
    const p = deno.run({
      args: allArgs,
      cwd: cwd,
      stdout: "inherit",
      stderr: "inherit"
    });
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

function getShellCommand(): string[] {
  let env = deno.env();
  if (deno.platform.os === "win") {
    return [env.COMSPEC || "cmd.exe", "/D", "/C"];
  } else {
    return [env.SHELL || "/bin/sh", "-c"];
  }
}

async function kill(p: Process) {
  console.log("kill", p.pid);
  const k = deno.run({
    args: ["kill", `${p.pid}`],
    stdout: "inherit",
    stderr: "inherit"
  });
  await k.status();
  k.close();
}

class Sequence implements Command {
  commands: Command[];
  constructor(commands: Command[]) {
    this.commands = commands;
  }
  validate(tasks: Tasks, context: ValidateContext) {
    this.commands.forEach(c => c.validate(tasks, context));
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
  validate(tasks: Tasks, context: ValidateContext) {
    this.commands.forEach(c => c.validate(tasks, context));
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
  validate(tasks: Tasks, context: ValidateContext) {
    if (context.hasWatcher) {
      throw new Error("Nested watchers not supported.");
    }
    this.command.validate(tasks, { ...context, hasWatcher: true });
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
  validate(tasks: Tasks, context: ValidateContext) {
    if (context.hasWatcher) {
      throw new Error("Nested watchers not supported.");
    }
    this.command.validate(tasks, { ...context, hasWatcher: true });
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
  shell?: boolean;
}
interface RunContext {
  taskFile: string;
  cwd: string;
  shell: boolean;
  resources: Set<Closer>;
  tasks: Tasks;
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
  async validate(taskName: string) {
    let command = this.tasks[taskName];
    if (!command) {
      throw new Error(`Task "${taskName}" not found.`);
    }
    command.validate(this.tasks, { checked: new Set(), hasWatcher: false });
  }
  async run(
    taskName: string,
    taskFile: string,
    args: string[] = [],
    options: RunOptions = {}
  ) {
    options = { cwd: ".", shell: true, ...options };
    this.validate(taskName);
    let command = this.tasks[taskName];
    await command.run(args, {
      taskFile,
      cwd: options.cwd,
      shell: options.shell,
      resources: new Set(),
      tasks: this.tasks
    });
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
function makeSingleCommand(script: string) {
  script = script.trim();
  if (!script.trim()) {
    throw new Error("Command should not be empty.");
  }
  return new Single(script);
}
