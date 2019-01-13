export namespace AST {
  export interface Command {
    command: string;
    input?: string;
    output?: string;
  }
  export type Sequence = LTree<Parallel>;
  export type Parallel = LTree<Command>;
}

export function parse(s: string): AST.Sequence {
  try {
    return seq(s);
  } catch (e) {
    if (e instanceof ParseError) {
      throw new Error(`Invalid command: ${s}`);
    }
    throw e;
  }
}
const redirects: Parser<AST.Command> = map(
  reduceCommand,
  sep(/([><])/, s => s.trim())
);
const para: Parser<AST.Parallel> = sep(/([&|])/, redirects);
const seq: Parser<AST.Sequence> = sep(/(&&|\|\|)/, para);

function reduceCommand(ast: LTree<string>): AST.Command {
  let result: AST.Command = { command: null };
  while (true) {
    if (typeof ast === "string") {
      result.command = ast.trim();
      break;
    }
    if (ast.op === "<") {
      result.input = ast.right.trim();
    } else if (ast.op === ">") {
      result.output = ast.right.trim();
    }
    ast = ast.left;
  }
  if (!result.command) {
    throw new ParseError();
  }
  if (result.input === "") {
    throw new ParseError();
  }
  if (result.output === "") {
    throw new ParseError();
  }
  return result;
}

// Utilities

function map<A, B>(f: (a: A) => B, p: Parser<A>): Parser<B> {
  return s => f(p(s));
}
function sep<A>(op: RegExp, each: Parser<A>): Parser<LTree<A>> {
  return (s: string) => {
    const arr = s.trim().split(op);
    if (!arr.length) {
      throw new ParseError();
    }
    let ast: LTree<A> = each(arr[0]);
    for (let i = 1; i < arr.length; i++) {
      const op = arr[i];
      i++;
      const right = each(arr[i]);
      ast = { left: ast, op, right };
    }
    return ast;
  };
}
type Parser<A> = (input: string) => A;
type LTree<A> = A | LBranch<A>;
interface LBranch<A> {
  left: LTree<A>;
  op: string;
  right: A;
}
class ParseError extends Error {}
