import { describe, expect, it } from 'vitest';
import { boardHref, pickTaskVersion, taskEditHref, taskHrefFrom } from './links';

const v = (id: string, number: string, completed = false, deleted_at: string | null = null) => ({
  id,
  number,
  completed,
  deleted_at,
});
const l = (version: string, task = 't1', deleted_at: string | null = null) => ({ version, task, deleted_at });

describe('links', () => {
  it('builds board and edit hrefs', () => {
    expect(boardHref()).toBe('/');
    expect(boardHref({ project: 'p', version: 'v', task: 't' })).toBe('/?project=p&version=v&task=t');
    expect(boardHref({ project: 'p', version: null })).toBe('/?project=p');
    expect(taskEditHref('t 1')).toBe('/task/?edit=t%201');
  });

  it('opens a task in its oldest incomplete version', () => {
    const versions = [v('a', '0.1.0', true), v('b', '0.10.0'), v('c', '0.9.0')];
    expect(pickTaskVersion('t1', [l('a'), l('b'), l('c')], versions)?.id).toBe('c');
  });

  it('falls back to the newest completed version', () => {
    const versions = [v('a', '0.1.0', true), v('b', '0.2.0', true)];
    expect(pickTaskVersion('t1', [l('a'), l('b')], versions)?.id).toBe('b');
  });

  it('ignores deleted links, deleted versions and other tasks', () => {
    const versions = [v('a', '0.1.0'), v('b', '0.2.0', false, 'x')];
    expect(pickTaskVersion('t1', [l('a', 't1', 'x'), l('b'), l('a', 't2')], versions)).toBeUndefined();
  });

  it('sends unscheduled tasks to the task editor', () => {
    expect(taskHrefFrom({ id: 't1', project: 'p' }, [], [])).toBe('/task/?edit=t1');
    expect(taskHrefFrom({ id: 't1', project: 'p' }, [l('a')], [v('a', '1.0.0')])).toBe(
      '/?project=p&version=a&task=t1'
    );
  });
});
