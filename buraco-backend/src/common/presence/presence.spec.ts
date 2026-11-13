import { onlineSet } from './presence';

describe('onlineSet', () => {
  it('reads online:<id> flags in one call and returns the online ids', async () => {
    const redis = { mget: jest.fn(async () => ['1', null, '1']) };
    const set = await onlineSet(redis as any, ['a', 'b', 'c', 'a']);
    expect(redis.mget).toHaveBeenCalledWith(['online:a', 'online:b', 'online:c']);
    expect([...set]).toEqual(['a', 'c']);
  });

  it('never throws: no Redis or a Redis error means everyone offline', async () => {
    expect((await onlineSet(undefined, ['a'])).size).toBe(0);
    const broken = { mget: jest.fn(async () => { throw new Error('down'); }) };
    expect((await onlineSet(broken as any, ['a'])).size).toBe(0);
  });
});
