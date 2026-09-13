// Deliberately small, interpreted query language. Never executes JavaScript.
const MAX_STEPS = 500000;
const MAX_RESULTS = 50000;
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);
const truthy = (value) => value !== null && value !== false;

function tokenize(source) {
  if (source.length > 4096) throw new Error('Query exceeds 4096 characters.');
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    if (/\s/.test(source[i])) { i++; continue; }
    const start = i;
    const char = source[i];
    if (char === '"' || char === "'") {
      let value = '';
      i++;
      let closed = false;
      while (i < source.length) {
        const next = source[i++];
        if (next === char) { closed = true; break; }
        if (next === '\\') {
          const escape = source[i++];
          if (escape === 'u') {
            const hex = source.slice(i, i + 4);
            if (!/^[a-f\d]{4}$/i.test(hex)) throw new Error(`Invalid Unicode escape at ${i}.`);
            value += String.fromCharCode(parseInt(hex, 16)); i += 4;
          } else {
            const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"', "'": "'" };
            if (!Object.hasOwn(escapes, escape)) throw new Error(`Invalid escape at ${i}.`);
            value += escapes[escape];
          }
        } else {
          if (next.charCodeAt(0) < 32) throw new Error('Unescaped control character in string.');
          value += next;
        }
      }
      if (!closed) throw new Error(`Unclosed string at ${start}.`);
      tokens.push({ type: 'string', value }); continue;
    }
    const number = source.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      const value = Number(number[0]);
      if (!Number.isFinite(value)) throw new Error('Number must be finite.');
      tokens.push({ type: 'number', value }); i += number[0].length; continue;
    }
    const name = source.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/);
    if (name) { tokens.push({ type: 'name', value: name[0] }); i += name[0].length; continue; }
    const pair = source.slice(i, i + 2);
    if (['..', '==', '!=', '>=', '<='].includes(pair)) {
      tokens.push({ type: pair }); i += 2; continue;
    }
    if ('.$[]()*|,:><'.includes(char)) { tokens.push({ type: char }); i++; continue; }
    throw new Error(`Unsupported character ${JSON.stringify(char)} at ${i}.`);
  }
  tokens.push({ type: 'EOF' });
  return tokens;
}

class Parser {
  constructor(source, mode) { this.tokens = tokenize(source); this.i = 0; this.mode = mode; }
  peek(type, value) { const token = this.tokens[this.i]; return token.type === type && (value === undefined || token.value === value); }
  take(type, value) { if (!this.peek(type, value)) return null; return this.tokens[this.i++]; }
  expect(type) { const token = this.take(type); if (!token) throw new Error(`Expected ${type}, found ${this.tokens[this.i].value ?? this.tokens[this.i].type}.`); return token; }
  parse() {
    const result = this.mode === 'jsonpath' ? this.path(true) : this.pipeline();
    this.expect('EOF');
    return result;
  }
  pipeline() {
    let node = this.binary(0);
    while (this.take('|')) node = { kind: 'pipe', left: node, right: this.binary(0) };
    return node;
  }
  binary(level) {
    const ops = [['or'], ['and'], ['==', '!=', '>', '<', '>=', '<=']];
    if (level === ops.length) return this.primary();
    let node = this.binary(level + 1);
    while (ops[level].some((op) => this.peek(op) || this.peek('name', op))) {
      const token = this.tokens[this.i++];
      node = { kind: 'binary', op: token.value || token.type, left: node, right: this.binary(level + 1) };
    }
    return node;
  }
  primary() {
    if (this.peek('.')) return this.path(false);
    if (this.take('(')) { const node = this.pipeline(); this.expect(')'); return node; }
    if (this.take('[')) { const node = this.pipeline(); this.expect(']'); return { kind: 'collect', node }; }
    if (this.peek('number') || this.peek('string')) return { kind: 'literal', value: this.tokens[this.i++].value };
    const name = this.expect('name').value;
    if (['true', 'false', 'null'].includes(name)) return { kind: 'literal', value: JSON.parse(name) };
    if (['map', 'select', 'sort_by'].includes(name)) {
      this.expect('('); const node = this.pipeline(); this.expect(')');
      return { kind: 'call', name, node };
    }
    if (['keys', 'length', 'type', 'sort', 'reverse'].includes(name)) return { kind: 'call', name };
    throw new Error(`Unsupported function: ${name}. See Query help for the supported subset.`);
  }
  path(jsonpath) {
    this.expect(jsonpath ? '$' : '.');
    const steps = [];
    if (!jsonpath && this.peek('name')) steps.push({ kind: 'key', key: this.tokens[this.i++].value });
    while (true) {
      if (this.take('.')) {
        if (jsonpath && this.take('*')) steps.push({ kind: 'wildcard' });
        else steps.push({ kind: 'key', key: this.expect('name').value });
      } else if (jsonpath && this.take('..')) {
        steps.push(this.take('*') ? { kind: 'recursive', key: null } : { kind: 'recursive', key: this.expect('name').value });
      } else if (this.take('[')) {
        if (this.take('*')) { if (!jsonpath) throw new Error('Use [] to iterate in jq mode.'); steps.push({ kind: 'wildcard' }); }
        else if (!jsonpath && this.peek(']')) steps.push({ kind: 'wildcard' });
        else if (this.peek('string')) steps.push({ kind: 'key', key: this.tokens[this.i++].value });
        else {
          const start = this.take('number')?.value;
          if (this.take(':')) {
            const end = this.take('number')?.value;
            if ([start, end].some((n) => n !== undefined && !Number.isInteger(n))) throw new Error('Slice bounds must be integers.');
            steps.push({ kind: 'slice', start, end });
          } else {
            if (!Number.isInteger(start)) throw new Error('Expected an integer index or quoted property.');
            steps.push({ kind: 'index', index: start });
          }
        }
        this.expect(']');
      } else break;
    }
    return { kind: 'path', steps, jsonpath };
  }
}

function type(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
function equal(a, b) {
  if (a === b) return true;
  if (type(a) !== type(b) || a === null || typeof a !== 'object') return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => own(b, key) && equal(a[key], b[key]));
}
function compare(a, b) {
  const ranks = { null: 0, boolean: 1, number: 2, string: 3, array: 4, object: 5 };
  if (type(a) !== type(b)) return ranks[type(a)] - ranks[type(b)];
  if (a === b) return 0;
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const result = compare(a[i], b[i]); if (result) return result; }
    return a.length - b.length;
  }
  if (a && typeof a === 'object') {
    const aKeys = Object.keys(a).sort(), bKeys = Object.keys(b).sort();
    return compare(aKeys, bKeys) || compare(aKeys.map((key) => a[key]), bKeys.map((key) => b[key]));
  }
  return a < b ? -1 : 1;
}

export function query(input, source, mode = 'jq') {
  if (!['jq', 'jsonpath'].includes(mode)) throw new Error('Unknown query mode.');
  const ast = new Parser(source.trim() || (mode === 'jq' ? '.' : '$'), mode).parse();
  let steps = 0;
  function tick() { if (++steps > MAX_STEPS) throw new Error('Query work limit exceeded. Narrow your query.'); }
  function bounded(values) { if (values.length > MAX_RESULTS) throw new Error('Query exceeds 50,000 results. Narrow your query.'); return values; }
  function flat(values, fn) {
    const output = [];
    for (const value of values) { tick(); for (const result of fn(value)) { output.push(result); bounded(output); } }
    return output;
  }
  function walk(value, step, jsonpath) {
    tick();
    if (step.kind === 'recursive') {
      const output = [], stack = [value];
      while (stack.length) {
        tick(); const current = stack.pop();
        if (current === null || typeof current !== 'object') continue;
        const keys = Object.keys(current);
        for (const key of keys) if (step.key === null || key === step.key) { output.push(current[key]); bounded(output); }
        for (let i = keys.length - 1; i >= 0; i--) if (current[keys[i]] !== null && typeof current[keys[i]] === 'object') stack.push(current[keys[i]]);
      }
      return output;
    }
    if (step.kind === 'wildcard') {
      if (value !== null && typeof value === 'object') return bounded(Object.values(value));
      if (jsonpath) return [];
      throw new Error(`Cannot iterate ${type(value)}.`);
    }
    if (step.kind === 'slice') {
      if (!Array.isArray(value) && !(typeof value === 'string' && !jsonpath)) {
        if (jsonpath) return [];
        throw new Error('Slices require an array or string.');
      }
      const sliced = value.slice(step.start, step.end);
      return jsonpath ? bounded(sliced) : [sliced];
    }
    let key = step.kind === 'index' ? step.index : step.key;
    if (step.kind === 'index' && Array.isArray(value) && key < 0) key += value.length;
    if ((step.kind === 'index' && !Array.isArray(value)) || (step.kind === 'key' && Array.isArray(value))) {
      if (jsonpath) return [];
      if (value === null) return [null];
      throw new Error(`Cannot index ${type(value)} with ${step.kind === 'index' ? 'a number' : 'a string'}.`);
    }
    if (own(value, key)) return [value[key]];
    if (jsonpath) return [];
    if (value !== null && typeof value !== 'object') throw new Error(`Cannot index ${type(value)}.`);
    return [null];
  }
  function evaluate(node, value) {
    tick();
    if (node.kind === 'literal') return [node.value];
    if (node.kind === 'path') return node.steps.reduce((values, step) => flat(values, (item) => walk(item, step, node.jsonpath)), [value]);
    if (node.kind === 'pipe') return flat(evaluate(node.left, value), (item) => evaluate(node.right, item));
    if (node.kind === 'collect') return [evaluate(node.node, value)];
    if (node.kind === 'binary') {
      return flat(evaluate(node.left, value), (left) => {
        if (node.op === 'and' && !truthy(left)) return [false];
        if (node.op === 'or' && truthy(left)) return [true];
        return evaluate(node.right, value).map((right) => {
        tick();
        switch (node.op) {
          case 'and': return truthy(left) && truthy(right);
          case 'or': return truthy(left) || truthy(right);
          case '==': return equal(left, right);
          case '!=': return !equal(left, right);
          case '>': return compare(left, right) > 0;
          case '<': return compare(left, right) < 0;
          case '>=': return compare(left, right) >= 0;
          case '<=': return compare(left, right) <= 0;
        }
        });
      });
    }
    if (node.name === 'select') return evaluate(node.node, value).filter(truthy).map(() => value);
    if (node.name === 'type') return [type(value)];
    if (node.name === 'length') {
      if (value === null) return [0];
      if (typeof value === 'number') return [Math.abs(value)];
      if (typeof value === 'string') return [[...value].length];
      if (typeof value === 'object') return [Object.keys(value).length];
      throw new Error('length does not accept booleans.');
    }
    if (node.name === 'keys') {
      if (value === null || typeof value !== 'object') throw new Error('keys requires an object or array.');
      return [Array.isArray(value) ? Array.from(value.keys()) : Object.keys(value).sort()];
    }
    if (!Array.isArray(value)) throw new Error(`${node.name} requires an array.`);
    if (node.name === 'map') return [flat(value, (item) => evaluate(node.node, item))];
    if (node.name === 'reverse') return [[...value].reverse()];
    if (node.name === 'sort') return [[...value].sort((a, b) => { tick(); return compare(a, b); })];
    if (node.name === 'sort_by') {
      const keyed = value.map((item) => ({ item, key: evaluate(node.node, item) }));
      keyed.sort((a, b) => { tick(); return compare(a.key, b.key); });
      return [keyed.map(({ item }) => item)];
    }
    throw new Error('Unsupported expression.');
  }
  return bounded(evaluate(ast, input));
}
