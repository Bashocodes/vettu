/**
 * Read the film's state script WITHOUT eval or vm (BOARD_DATA §6b):
 * string-aware comment strip → for each `window.NAME =` slice `[`/`{` values by string-aware
 * bracket matching → quote bare keys (only after `{` or `,`, word followed by `:`) → drop trailing
 * commas → JSON.parse. Numbers → parseFloat. Functions are skipped. Anything malformed fails closed
 * with HttpError 503 film_state_unreadable.
 */
import { HttpError } from "../guard";

export function unreadable(): HttpError {
  return new HttpError(503, "film_state_unreadable", { error: "film_state_unreadable" });
}

/** Index just past the string literal that starts at `i`. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === "\n" && quote !== "`") throw unreadable();
    j++;
  }
  throw unreadable();
}

/** Remove `//` and `/* *\/` comments that sit outside string literals. */
export function stripComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) throw unreadable();
      out += " ";
      i = close + 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Index just past the bracket that closes the one at `start` (string-aware). */
function matchBracket(text: string, start: number): number {
  const stack: string[] = [];
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
      continue;
    }
    if (c === "[") stack.push("]");
    else if (c === "{") stack.push("}");
    else if (c === "(") stack.push(")");
    else if (c === "]" || c === "}" || c === ")") {
      if (stack.pop() !== c) throw unreadable();
      if (stack.length === 0) return i + 1;
    }
    i++;
  }
  throw unreadable();
}

/** A JS object/array literal (double-quoted strings only) → JSON text. */
export function jsLiteralToJson(slice: string): string {
  let out = "";
  let i = 0;
  const previous = () => {
    for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return out[k];
    return "";
  };
  while (i < slice.length) {
    const c = slice[i];
    if (c === '"') {
      const end = skipString(slice, i);
      out += slice.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === "`") throw unreadable();
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < slice.length && /[\w$]/.test(slice[j])) j++;
      const word = slice.slice(i, j);
      let k = j;
      while (k < slice.length && /\s/.test(slice[k])) k++;
      const p = previous();
      out += (p === "{" || p === ",") && slice[k] === ":" ? JSON.stringify(word) : word;
      i = j;
      continue;
    }
    if (c === "}" || c === "]") {
      out = out.replace(/,\s*$/, "");
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Every `window.NAME = value` the state script sets (functions skipped). */
export function parseFilmState(text: string): Record<string, unknown> {
  const source = stripComments(text);
  const result: Record<string, unknown> = {};
  const assign = /window\.([A-Za-z_$][\w$]*)\s*=(?!=)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = assign.exec(source))) {
    const name = m[1];
    const i = assign.lastIndex;
    const c = source[i] ?? "";
    if (c === "[" || c === "{") {
      const end = matchBracket(source, i);
      try {
        result[name] = JSON.parse(jsLiteralToJson(source.slice(i, end)));
      } catch {
        throw unreadable();
      }
      assign.lastIndex = end;
    } else if (/[-\d.]/.test(c)) {
      const num = /^-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i.exec(source.slice(i, i + 64));
      if (!num) throw unreadable();
      result[name] = parseFloat(num[0]);
      assign.lastIndex = i + num[0].length;
    } else if (source.startsWith("function", i)) {
      const open = source.indexOf("{", i);
      if (open < 0) throw unreadable();
      assign.lastIndex = matchBracket(source, open);
    } else if (c === '"') {
      const end = skipString(source, i);
      try {
        result[name] = JSON.parse(source.slice(i, end));
      } catch {
        throw unreadable();
      }
      assign.lastIndex = end;
    }
    // any other expression is not a value VETTU reads
  }
  return result;
}
