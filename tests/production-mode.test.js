import test from 'node:test';
import assert from 'node:assert/strict';
import {isProduction} from '../local/mode.js';
test('production detection',()=>{
  assert.equal(isProduction({NODE_ENV:'production'}),true);
  assert.equal(isProduction({NODE_ENV:'development',PUBLIC_ORIGIN:'https://tic-tac-toe.jevplay.games'}),true);
  assert.equal(isProduction({PUBLIC_ORIGIN:'https://example.com'}),true);
  assert.equal(isProduction({PUBLIC_ORIGIN:'http://localhost:8787'}),false);
  assert.equal(isProduction({PUBLIC_ORIGIN:'https://localhost'}),false);
  assert.equal(isProduction({PUBLIC_ORIGIN:'https://127.0.0.1:8443'}),false);
  assert.equal(isProduction({PUBLIC_ORIGIN:'http://example.com'}),false);
  assert.equal(isProduction({}),false);
});
