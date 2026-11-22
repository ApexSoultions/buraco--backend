'use client';
import { createContext, ReactNode, useContext, useEffect, useState } from 'react';
import api from '@/lib/api';

export type AdminRole = 'SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT';

export interface Admin {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

export const ROLE_LABEL: Record<AdminRole, string> = {
  SUPER_ADMIN: 'Super admin',
  MODERATOR: 'Moderator',
  SUPPORT: 'Support',
};

export const ALL_ROLES: AdminRole[] = ['SUPER_ADMIN', 'MODERATOR', 'SUPPORT'];

interface Ctx {
  admin: Admin | null;
  loading: boolean;
  /** True when the logged-in admin has one of these roles. */
  can: (roles: AdminRole[]) => boolean;
}

const AdminContext = createContext<Ctx>({ admin: null, loading: true, can: () => false });

/**
 * Loads the logged-in admin (GET /admin/me) once for the whole panel. The server checks the role
 * on every request; this only hides what the admin isn't allowed to use.
 */
export function AdminProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/admin/me')
      .then((r) => setAdmin(r.data.data))
      .catch(() => setAdmin(null))
      .finally(() => setLoading(false));
  }, []);

  const can = (roles: AdminRole[]) => !!admin && roles.includes(admin.role);
  return <AdminContext.Provider value={{ admin, loading, can }}>{children}</AdminContext.Provider>;
}

export const useAdmin = () => useContext(AdminContext);

/** Shows the page only to these roles; others see a short "no access" note. */
export function RequireRole({ roles, children }: { roles: AdminRole[]; children: ReactNode }) {
  const { loading, can } = useAdmin();
  if (loading) return null;
  if (!can(roles)) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
        <p className="font-medium text-slate-900">No access</p>
        <p className="text-sm text-slate-500 mt-1">Your role can&apos;t open this page. Ask a super admin if you need it.</p>
      </div>
    );
  }
  return <>{children}</>;
}

type ServerError = {
  response?: {
    status?: number;
    // The server answers { success: false, error: { message } }.
    data?: { error?: { message?: string | string[] }; message?: string | string[] };
  };
};

/** HTTP status of a failed request (0 when the server could not be reached). */
export const errorStatus = (e: unknown): number => (e as ServerError)?.response?.status ?? 0;

/** The server's error message / code, e.g. "LAST_SUPER_ADMIN". */
export function errorCode(e: unknown): string {
  const d = (e as ServerError)?.response?.data;
  const m = d?.error?.message ?? d?.message;
  return (Array.isArray(m) ? m[0] : m) ?? '';
}

/** Turns a server error into a short message for a toast. */
export function errorText(e: unknown, fallback: string): string {
  if (errorStatus(e) === 403) return "Your role can't do this.";
  if (errorStatus(e) === 0) return `${fallback} (the server can't be reached)`;
  const text = errorCode(e);
  return text ? `${fallback} (${text})` : fallback;
}
