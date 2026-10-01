import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-auth-'));
process.env.GITHUB_TOKEN = 'envdefault_aaaaaaaaaaaaaaaaaaaa';
process.env.GITHUB_TOKENS = 'envorg=envorgtoken_aaaaaaaaaaaaaaaaaaa';
const A = await import('../src/githubAuth.js');

const tok = (n) => `ghp_${n.repeat(24)}`;

test('token lookup order: saved owner > env owner > saved default > env default', () => {
  assert.deepEqual(A.resolveToken('EnvOrg/x'), { token: 'envorgtoken_aaaaaaaaaaaaaaaaaaa', source: 'env' });
  assert.equal(A.resolveToken('other/x').source, 'env-default');
  A.saveToken('*', tok('d'));
  assert.equal(A.resolveToken('other/x').source, 'saved-default');
  A.saveToken('EnvOrg', tok('o'));
  assert.deepEqual(A.resolveToken('envorg/x'), { token: tok('o'), source: 'saved' });
  A.removeToken('envorg');
  assert.equal(A.resolveToken('envorg/x').source, 'env');
});

test('credential list is masked and never contains a full token', () => {
  A.saveToken('acme', tok('z'));
  const json = JSON.stringify(A.listCredentials());
  assert.ok(json.includes('acme'));
  assert.ok(!json.includes(tok('z')));
});

test('input validation', () => {
  assert.throws(() => A.cleanOwner('bad owner!'));
  assert.throws(() => A.cleanToken('short'));
  assert.equal(A.cleanOwner(' Acme-Org '), 'acme-org');
});
