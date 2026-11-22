import Sidebar from '@/components/layout/Sidebar';
import { AdminProvider } from '@/lib/admin';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminProvider>
      <div className="flex min-h-screen">
        <Sidebar />
        <div className="flex-1 overflow-auto">
          <div className="max-w-6xl mx-auto px-6 py-7">
            {children}
          </div>
        </div>
      </div>
    </AdminProvider>
  );
}
