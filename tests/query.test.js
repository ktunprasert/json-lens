import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../query.js';
import { childPath, jqPath } from '../tree.js';

const data = {
  users: [
    { name: 'Ada', age: 36, active: true },
    { name: 'Grace', age: 28, active: false },
    { name: 'Linus', age: 31, active: true },
  ],
  meta: { name: 'people', 'odd.key': { 'quote"key': 42 } },
};

const cases = [
  ['jsonpath', '$', [data]],
  ['jsonpath', '$.users[0].name', ['Ada']],
  ['jsonpath', '$.users[-1].name', ['Linus']],
  ['jsonpath', '$.users[*].name', ['Ada', 'Grace', 'Linus']],
  ['jsonpath', '$..name', ['Ada', 'Grace', 'Linus', 'people']],
  ['jsonpath', '$.users[1:3].name', ['Grace', 'Linus']],
  ['jsonpath', '$.users[:1].name', ['Ada']],
  ['jsonpath', '$.users[-2:].name', ['Grace', 'Linus']],
  ['jsonpath', '$["meta"][\'odd.key\']["quote\\\"key"]', [42]],
  ['jsonpath', '$.missing', []],
  ['jsonpath', '$.users[10]', []],
  ['jq', '.', [data]],
  ['jq', '.users[] | .name', ['Ada', 'Grace', 'Linus']],
  ['jq', '.users[] | select(.active == true) | .name', ['Ada', 'Linus']],
  ['jq', '.users | map(select(.age >= 30) | .name)', [['Ada', 'Linus']]],
  ['jq', '.users | sort_by(.age) | map(.name)', [['Grace', 'Linus', 'Ada']]],
  ['jq', '.users | sort_by(.age) | reverse | map(.name)', [['Ada', 'Linus', 'Grace']]],
  ['jq', '[.users[] | select(.active) | .name]', [['Ada', 'Linus']]],
  ['jq', '.users[] | select(.age > 30 and .age < 35) | .name', ['Linus']],
  ['jq', '.users[] | select(.age < 30 or .name == "Ada") | .name', ['Ada', 'Grace']],
  ['jq', '.users | length', [3]],
  ['jq', '.meta | keys', [['name', 'odd.key']]],
  ['jq', '.users | keys', [[0, 1, 2]]],
  ['jq', '.users | type', ['array']],
  ['jq', '.missing.deep', [null]],
  ['jq', '.users[0:2] | map(.name)', [['Ada', 'Grace']]],
  ['jq', '.users[-1].name', ['Linus']],
  ['jq', '.users[] | select(.name == "A|B")', []],
  ['jq', '.users[] | select((.active == true) and (.age != 36)) | .name', ['Linus']],
];
for (const [mode, expression, expected] of cases) {
  test(`${mode}: ${expression}`, () => assert.deepEqual(query(data, expression, mode), expected));
}

test('root JSON scalars and empty queries', () => {
  for (const value of [null, false, 0, '', 'hello', [], {}]) {
    assert.deepEqual(query(value, '', 'jq'), [value]);
    assert.deepEqual(query(value, '', 'jsonpath'), [value]);
  }
});
test('jq truthiness and short-circuit boolean expressions', () => {
  for (const value of [0, '', [], {}]) assert.deepEqual(query(value, 'select(.)'), [value]);
  for (const value of [false, null]) assert.deepEqual(query(value, 'select(.)'), []);
  assert.deepEqual(query(1, 'false and .invalid'), [false]);
  assert.deepEqual(query(1, 'true or .invalid'), [true]);
});
test('deep equality ignores object property order', () => {
  assert.deepEqual(query({ a: { x: 1, y: [2] }, b: { y: [2], x: 1 } }, '.a == .b'), [true]);
});
test('sort preserves jq type order and numeric ordering', () => {
  assert.deepEqual(query(['a', 10, 2, null, true, false, [], {}], 'sort'), [[null, false, true, 2, 10, 'a', [], {}]]);
});
test('Unicode lengths, null length, numeric length', () => {
  assert.deepEqual(query('🙂', 'length'), [1]);
  assert.deepEqual(query(null, 'length'), [0]);
  assert.deepEqual(query(-12, 'length'), [12]);
});
test('own-property access only, including hostile JSON keys', () => {
  assert.deepEqual(query({}, '$.constructor', 'jsonpath'), []);
  assert.deepEqual(query({}, '.toString'), [null]);
  assert.deepEqual(query(JSON.parse('{"__proto__":{"safe":1}}'), '.__proto__.safe'), [1]);
  assert.equal({}.safe, undefined);
});
test('tree-generated paths round-trip unusual keys in both modes', () => {
  for (const key of ['normal', 'a.b', 'a"b', 'a\\b', '', 'with spaces', '\n', '😀', '0', '__proto__']) {
    const value = { [key]: [42] };
    const path = childPath(childPath('$', key, false), '0', true);
    assert.deepEqual(query(value, path, 'jsonpath'), [42]);
    assert.deepEqual(query(value, jqPath(path), 'jq'), [42]);
  }
  assert.equal(jqPath('$'), '.');
});
test('invalid or unsupported expressions fail explicitly', () => {
  for (const expression of ['.users | eval("bad")', '.users |', '.users[', '.users[*]', 'alert(1)', '.;globalThis.x=1', '{name: .name}', '.users | map()', '1e999', '"bad\\x"']) {
    assert.throws(() => query(data, expression), undefined, expression);
  }
  for (const expression of ['$..', '$.users[?(@.age > 30)]', '$.users[0,1]', '$.users[1.2]', '$.users[::2]', '$.users | length']) {
    assert.throws(() => query(data, expression, 'jsonpath'), undefined, expression);
  }
});
test('type errors are distinct from absent fields', () => {
  for (const expression of ['.name', '.[]', 'map(.)', 'keys']) assert.throws(() => query(1, expression));
  assert.throws(() => query([], '.name'));
  assert.throws(() => query({}, '.[0]'));
  assert.deepEqual(query(null, '.name'), [null]);
});
test('bounded query length and output expansion', () => {
  assert.throws(() => query({}, '.'.repeat(4097)), /4096/);
  assert.throws(() => query(Array(50001).fill(1), '.[]'), /50,000/);
});
