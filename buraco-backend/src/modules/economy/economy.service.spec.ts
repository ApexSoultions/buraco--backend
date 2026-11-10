import { EconomyService } from './economy.service';

// The daily reward used to check and then set its marker separately, so two requests at
// the same moment could both be paid. The marker is now taken atomically first.
describe('EconomyService.claimDailyReward', () => {
  function setup(markerFree: boolean, addCoinsFails = false) {
    const redis = {
      setIfAbsent: jest.fn(async () => markerFree),
      del: jest.fn(async () => 1),
    };
    const sysConfig = { getNumber: jest.fn(async () => 200) };
    const service = new EconomyService({} as any, redis as any, sysConfig as any);
    const addCoins = jest.spyOn(service, 'addCoins').mockImplementation(async () => {
      if (addCoinsFails) throw new Error('db down');
      return 1700;
    });
    return { service, redis, addCoins };
  }

  it('pays once and returns the new balance', async () => {
    const { service, redis, addCoins } = setup(true);
    const res: any = await service.claimDailyReward('u1');

    expect(res).toEqual(expect.objectContaining({ claimed: true, coinsAwarded: 200, coins: 1700 }));
    expect(redis.setIfAbsent).toHaveBeenCalledWith('daily:u1', '1', expect.any(Number));
    expect(addCoins).toHaveBeenCalledTimes(1);
  });

  it('does not pay when the day is already taken', async () => {
    const { service, addCoins } = setup(false);
    const res: any = await service.claimDailyReward('u1');

    expect(res.claimed).toBe(false);
    expect(res.nextClaimAt).toMatch(/T00:00:00.000Z$/);
    expect(addCoins).not.toHaveBeenCalled();
  });

  it('frees the day again if the payment fails', async () => {
    const { service, redis } = setup(true, true);
    await expect(service.claimDailyReward('u1')).rejects.toThrow('db down');
    expect(redis.del).toHaveBeenCalledWith('daily:u1');
  });
});
