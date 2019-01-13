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
  const unsupportedOperators = s.match(/(>>|\|&)/g) || [];
  if (unsupportedOperators.length) {
    throw new Error(`Unsupported operator: ${unsupportedOperators.join(" ")}`);
  }
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
    if (ast instanceof Leaf) {
      result.command = ast.value.trim();
      break;
    }
    if (ast.op === "<") {
      const input = ast.right.trim();
      if (!input) {
        throw new ParseError();
      }
      result.input = result.input || input;
    } else if (ast.op === ">") {
      const output = ast.right.trim();
      if (!output) {
        throw new ParseError();
      }
      result.output = result.output;
    }
    ast = ast.left;
  }
  if (!result.command) {
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
    let ast: LTree<A> = new Leaf(each(arr[0]));
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
type LTree<A> = Leaf<A> | LBranch<A>;
export class Leaf<A> {
  constructor(public value: A) {}
}
interface LBranch<A> {
  left: LTree<A>;
  op: string;
  right: A;
}
class ParseError extends Error {}
