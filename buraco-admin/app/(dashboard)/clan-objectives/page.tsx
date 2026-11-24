'use client';
import GoalManager from '@/components/content/GoalManager';
import { RequireRole } from '@/lib/admin';

export default function ClanObjectivesPage() {
  return (
    <RequireRole roles={['SUPER_ADMIN']}>
      <GoalManager
        endpoint="objectives"
        title="Clan objectives"
        noun="clan objective"
        intro="Weekly goals for a whole clan. Their progress starts again every Monday. Finishing one pays every active member coins and adds points to the clan."
        rewards={[{ key: 'rewardCoins', label: 'Coins (each member)' }, { key: 'rewardClubPoints', label: 'Clan points' }]}
        stats={[{ label: 'Completed', value: (g) => `${g.completedTimes ?? 0}×` }]}
      />
    </RequireRole>
  );
}
