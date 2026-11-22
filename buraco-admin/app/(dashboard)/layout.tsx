import Shell from '@/components/layout/Shell';
import { AdminProvider } from '@/lib/admin';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminProvider>
      <Shell>{children}</Shell>
    </AdminProvider>
  );
}
