'use client';
import { ReactNode, useState } from 'react';
import Sidebar from './Sidebar';
import Topbar from './Topbar';

/** Side menu + top bar + page. The side menu is a drawer on phones (opened from the top bar). */
export default function Shell({ children }: { children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="flex min-h-screen bg-slate-50">
      <Sidebar open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex-1 min-w-0 flex flex-col">
        <Topbar onMenu={() => setMenuOpen(true)} />
        <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-5 lg:px-6 lg:py-7">{children}</main>
      </div>
    </div>
  );
}
