import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, parseLog, parseGithubRemote } from '../src/collectors/git.js';
import { demux, workdirKey, matchContainers } from '../src/collectors/docker.js';

test('parseGithubRemote handles https and ssh', () => {
  assert.equal(parseGithubRemote('https://github.com/octocat/Hello-World.git'), 'octocat/Hello-World');
  assert.equal(parseGithubRemote('git@github.com:octocat/Hello-World.git\n'), 'octocat/Hello-World');
  assert.equal(parseGithubRemote('https://gitlab.com/a/b.git'), null);
  assert.equal(parseGithubRemote(''), null);
});

test('parseStatus counts changes and ahead/behind', () => {
  const s = parseStatus(['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', '1 .M N... 100644 100644 100644 a b file.js', '2 R. N... 100644 100644 100644 a b R100 new.js\told.js', '? scratch.txt', 'u UU N... 1 2 3 4 a b c conflict.js'].join('\n'));
  assert.deepEqual(s, { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 1, changed: 2, untracked: 1, conflicted: 1, detached: false });
});

test('parseLog', () => {
  const [c] = parseLog('abcdef1234567\x1fJT\x1f1700000000\x1ffix: thing');
  assert.equal(c.hash, 'abcdef1');
  assert.equal(c.at, 1700000000000);
  assert.equal(c.subject, 'fix: thing');
});

test('demux strips docker frame headers', () => {
  const frame = (t, s) => Buffer.concat([Buffer.from([t, 0, 0, 0, 0, 0, 0, s.length]), Buffer.from(s)]);
  assert.equal(demux(Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n')])), 'hello\noops\n');
  assert.equal(demux(Buffer.from('plain tty output')), 'plain tty output');
});

test('containers map to projects by compose working dir (Windows paths too)', () => {
  assert.equal(workdirKey('G:\\Github Repos\\kidtube\\'), 'kidtube');
  const cs = [
    { id: 'a', workdirKey: 'kidtube', composeProject: 'kidtube' },
    { id: 'b', workdirKey: null, composeProject: 'pagepulse' },
    { id: 'c', workdirKey: null, composeProject: null },
  ];
  const { byProject, other } = matchContainers(cs, ['kidtube', 'PagePulse', 'x']);
  assert.equal(byProject.kidtube.length, 1);
  assert.equal(byProject.PagePulse.length, 1);
  assert.equal(other.length, 1);
});
