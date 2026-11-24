'use client';
import GoalManager from '@/components/content/GoalManager';
import { RequireRole } from '@/lib/admin';

export default function AchievementsPage() {
  return (
    <RequireRole roles={['SUPER_ADMIN']}>
      <GoalManager
        endpoint="achievements"
        title="Achievements"
        noun="achievement"
        intro="Lifetime goals for each player (for example Win 10 games). They never reset and each reward is claimed once."
        rewards={[{ key: 'rewardCoins', label: 'Coins' }, { key: 'rewardDiamonds', label: 'Diamonds' }]}
        stats={[{ label: 'Done / claimed', value: (g) => `${g.completedBy ?? 0} / ${g.claimedBy ?? 0}` }]}
      />
    </RequireRole>
  );
}
