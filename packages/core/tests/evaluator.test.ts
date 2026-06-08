import { describe, expect, test } from 'vitest';
import {
  allowAllCalls,
  compileExpression,
  evaluate,
  JSParseError,
  parseExpression,
} from '../src/expr/index.js';

describe('pure-expr evaluator re-export', () => {
  test('evaluates basic expressions through pure-expr', () => {
    expect(evaluate('price * quantity', { price: 12, quantity: 3 })).toBe(36);
    expect(evaluate('user?.name ?? "anonymous"', { user: {} })).toBe('anonymous');
  });

  test('parses and compiles reusable expressions', () => {
    const ast = parseExpression('items.length + 1');
    expect(ast.type).toBeTruthy();

    const compiled = compileExpression('count + 1');
    expect(compiled.evaluate({ count: 4 })).toBe(5);
    expect(compiled.evaluate({ count: 9 })).toBe(10);
  });

  test('uses pure-expr call policy', () => {
    expect(() => evaluate('format(name)', {
      name: 'Ada',
      format: (value: string) => value.toUpperCase(),
    })).toThrow('not permitted');

    expect(evaluate('format(name)', {
      name: 'Ada',
      format: (value: string) => value.toUpperCase(),
    }, {
      isCallableAllowed: allowAllCalls,
    })).toBe('ADA');
  });

  test('uses Hack-style pipeline topic references', () => {
    expect(evaluate('5 |> double(%) |> String(%)', {
      double: (value: number) => value * 2,
      String,
    }, {
      isCallableAllowed: allowAllCalls,
    })).toBe('10');
  });

  test('reports pure-expr parse errors', () => {
    expect(() => evaluate('1 + * 2')).toThrow(JSParseError);
  });
});
