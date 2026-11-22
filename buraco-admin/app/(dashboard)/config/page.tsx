'use client';
import { useState } from 'react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { useFetch } from '@/hooks/useFetch';
import { useMutation } from '@/hooks/useMutation';
import { TableSkeleton } from '@/components/ui/Skeleton';
import Empty from '@/components/ui/Empty';

interface Config { id: string; key: string; value: string; updatedAt: string; }

interface ConfigMeta {
  label: string;
  description: string;
  type: 'number' | 'boolean' | 'string' | 'version' | 'secret';
  unit?: string;
  group: string;
}

const META: Record<string, ConfigMeta> = {
  // ── App ──────────────────────────────────────────────────────────────────────
  maintenance_mode:           { label: 'Maintenance Mode',         description: 'Set to "true" to take the app offline for all players.',                                  type: 'boolean', group: 'App' },
  min_version_ios:            { label: 'Min iOS Version',          description: 'Minimum app version accepted on iOS. Users below this are prompted to update.',            type: 'version', group: 'App' },
  min_version_android:        { label: 'Min Android Version',      description: 'Minimum app version accepted on Android.',                                                 type: 'version', group: 'App' },
  // ── Game ─────────────────────────────────────────────────────────────────────
  turn_duration_seconds:      { label: 'Turn Duration',            description: 'Seconds a player has to make their move before the turn auto-skips.',                      type: 'number', unit: 'sec',  group: 'Game' },
  disconnect_timeout_seconds: { label: 'Disconnect Timeout',       description: 'Seconds a player can stay disconnected before being removed from the game.',                type: 'number', unit: 'sec',  group: 'Game' },
  // ── Economy ──────────────────────────────────────────────────────────────────
  new_user_coins:             { label: 'New User Coins',           description: 'Coins granted to every newly registered player.',                                          type: 'number', unit: 'coins', group: 'Economy' },
  new_user_diamonds:          { label: 'New User Diamonds',        description: 'Diamonds granted to every newly registered player.',                                       type: 'number', unit: 'gems',  group: 'Economy' },
  new_user_lives:             { label: 'New User Lives',           description: 'Lives granted to every newly registered player.',                                          type: 'number', unit: 'lives', group: 'Economy' },
  daily_login_reward_coins:   { label: 'Daily Login Reward',       description: 'Coins awarded for logging in each day.',                                                   type: 'number', unit: 'coins', group: 'Economy' },
  // ── Matchmaking ──────────────────────────────────────────────────────────────
  classic_entry_fee:          { label: 'Classic Entry Fee',        description: 'Coins deducted from each player entering a Classic mode game.',                            type: 'number', unit: 'coins', group: 'Matchmaking' },
  professional_entry_fee:     { label: 'Professional Entry Fee',   description: 'Coins deducted from each player entering a Professional mode game.',                       type: 'number', unit: 'coins', group: 'Matchmaking' },
  // ── Clubs ────────────────────────────────────────────────────────────────────
  max_club_members:           { label: 'Max Club Members',         description: 'Maximum number of members allowed in a single club.',                                      type: 'number', unit: 'users', group: 'Clubs' },
  // ── Rate Limiting ────────────────────────────────────────────────────────────
  throttle_ttl_seconds:       { label: 'Rate Limit Window',        description: 'Time window in seconds used for rate limiting API requests.',                              type: 'number', unit: 'sec',  group: 'Rate Limiting' },
  throttle_limit:             { label: 'Rate Limit Max Requests',  description: 'Maximum number of API requests allowed per user within the rate limit window.',             type: 'number', unit: 'req',  group: 'Rate Limiting' },
  // ── Integrations — Google OAuth ───────────────────────────────────────────────
  google_client_id:           { label: 'Google Client ID',         description: 'OAuth 2.0 client ID from Google Cloud Console. Used to verify Google Sign-In tokens.',    type: 'string',  group: 'Integrations' },
  google_client_secret:       { label: 'Google Client Secret',     description: 'OAuth 2.0 client secret from Google Cloud Console.',                                      type: 'secret',  group: 'Integrations' },
  // ── Integrations — Apple Sign-In ──────────────────────────────────────────────
  apple_client_id:            { label: 'Apple Client ID',          description: 'Services ID (bundle ID) registered in Apple Developer for Sign in with Apple.',           type: 'string',  group: 'Integrations' },
  apple_team_id:              { label: 'Apple Team ID',            description: '10-character Apple Developer Team ID.',                                                   type: 'string',  group: 'Integrations' },
  apple_key_id:               { label: 'Apple Key ID',             description: 'Key ID of the Sign in with Apple private key from Apple Developer.',                      type: 'string',  group: 'Integrations' },
  apple_private_key:          { label: 'Apple Private Key',        description: 'Contents of the .p8 private key file (include the BEGIN/END PRIVATE KEY lines).',         type: 'secret',  group: 'Integrations' },
  // ── Integrations — AWS S3 ─────────────────────────────────────────────────────
  aws_region:                 { label: 'AWS Region',               description: 'AWS region for S3 bucket (e.g. us-east-1).',                                              type: 'string',  group: 'Integrations' },
  aws_access_key_id:          { label: 'AWS Access Key ID',        description: 'IAM access key ID with S3 write permissions.',                                            type: 'string',  group: 'Integrations' },
  aws_secret_access_key:      { label: 'AWS Secret Access Key',    description: 'IAM secret access key — store carefully.',                                                type: 'secret',  group: 'Integrations' },
  aws_s3_bucket:              { label: 'S3 Bucket Name',           description: 'Name of the S3 bucket used for avatar uploads.',                                          type: 'string',  group: 'Integrations' },
  // ── Integrations — SMTP ───────────────────────────────────────────────────────
  smtp_host:                  { label: 'SMTP Host',                description: 'Mail server hostname (e.g. smtp.gmail.com).',                                             type: 'string',  group: 'Integrations' },
  smtp_port:                  { label: 'SMTP Port',                description: 'Mail server port. Use 587 for TLS, 465 for SSL.',                                         type: 'number', unit: 'port', group: 'Integrations' },
  smtp_user:                  { label: 'SMTP Username',            description: 'SMTP authentication username / email address.',                                           type: 'string',  group: 'Integrations' },
  smtp_pass:                  { label: 'SMTP Password',            description: 'SMTP authentication password or app password.',                                           type: 'secret',  group: 'Integrations' },
  smtp_from:                  { label: 'From Address',             description: 'Sender email address shown in outgoing emails.',                                          type: 'string',  group: 'Integrations' },
};

const GROUP_ORDER = ['App', 'Game', 'Economy', 'Matchmaking', 'Clubs', 'Rate Limiting', 'Integrations'];

function groupConfigs(configs: Config[]) {
  const groups: Record<string, Config[]> = {};
  for (const cfg of configs) {
    const g = META[cfg.key]?.group ?? 'Other';
    (groups[g] ??= []).push(cfg);
  }
  return groups;
}

function ValueBadge({ type, value }: { type: ConfigMeta['type']; value: string }) {
  if (type === 'boolean') {
    const on = value === 'true';
    return (
      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${on ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'}`}>
        <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-red-500' : 'bg-green-500'}`} />
        {on ? 'ON' : 'OFF'}
      </span>
    );
  }
  return <span className="font-semibold text-slate-900 text-sm">{value}</span>;
}

export default function ConfigPage() {
  const { data, loading, refetch } = useFetch<Config[]>('/admin/config');
  const configs = data ?? [];
  const groups = groupConfigs(configs);

  const [editing,   setEditing]   = useState<Record<string, string>>({});
  const [revealed,  setRevealed]  = useState<Record<string, boolean>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const { run } = useMutation();

  function startEdit(key: string, val: string) {
    setEditing((p) => ({ ...p, [key]: val }));
  }

  function cancelEdit(key: string) {
    setEditing((p) => { const n = { ...p }; delete n[key]; return n; });
  }

  async function save(key: string) {
    setSavingKey(key);
    const ok = await run(() => api.put(`/admin/config/${key}`, { value: editing[key] }));
    setSavingKey(null);
    if (ok) { toast.success(`Saved "${META[key]?.label ?? key}"`); cancelEdit(key); refetch(); }
    else    toast.error(`Failed to save "${META[key]?.label ?? key}"`);
  }

  const orderedGroups = [
    ...GROUP_ORDER.filter((g) => groups[g]),
    ...Object.keys(groups).filter((g) => !GROUP_ORDER.includes(g)),
  ];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900">Game settings</h1>
        <p className="text-sm text-slate-500 mt-0.5">Live runtime settings — changes take effect within 60 seconds</p>
      </div>

      {loading ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <TableSkeleton rows={8} cols={4} />
        </div>
      ) : configs.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <Empty message="No config entries found. Run the seed to populate defaults." />
        </div>
      ) : (
        <div className="space-y-6">
          {orderedGroups.map((group) => (
            <div key={group} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{group}</h2>
              </div>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-slate-50">
                  {groups[group].map((cfg) => {
                    const meta = META[cfg.key];
                    const isEditing = editing[cfg.key] !== undefined;
                    return (
                      <tr key={cfg.key} className="hover:bg-slate-50/60 transition-colors">
                        {/* Setting name + description */}
                        <td className="px-4 py-3 w-72">
                          <p className="font-medium text-slate-800 text-sm">{meta?.label ?? cfg.key}</p>
                          {meta?.description && (
                            <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{meta.description}</p>
                          )}
                          <p className="font-mono text-[10px] text-slate-300 mt-0.5">{cfg.key}</p>
                        </td>

                        {/* Value */}
                        <td className="px-4 py-3">
                          {isEditing ? (
                            <div className="flex items-center gap-2">
                              <input
                                type={meta?.type === 'secret' ? 'password' : 'text'}
                                value={editing[cfg.key]}
                                onChange={(e) => setEditing((p) => ({ ...p, [cfg.key]: e.target.value }))}
                                className="rounded-lg border border-blue-300 ring-1 ring-blue-300 px-2.5 py-1.5 text-sm w-52 outline-none bg-white font-mono"
                                autoFocus
                                autoComplete="off"
                              />
                              {meta?.unit && (
                                <span className="text-xs text-slate-400">{meta.unit}</span>
                              )}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              {meta?.type === 'secret' ? (
                                <>
                                  <span className="font-mono text-sm text-slate-500 tracking-widest">
                                    {cfg.value ? (revealed[cfg.key] ? cfg.value : '••••••••') : <span className="text-slate-300 italic text-xs">not set</span>}
                                  </span>
                                  {cfg.value && (
                                    <button
                                      onClick={() => setRevealed((p) => ({ ...p, [cfg.key]: !p[cfg.key] }))}
                                      className="text-[10px] text-slate-400 hover:text-blue-500 border border-slate-200 rounded px-1.5 py-0.5"
                                    >
                                      {revealed[cfg.key] ? 'Hide' : 'Reveal'}
                                    </button>
                                  )}
                                </>
                              ) : (
                                <>
                                  <ValueBadge type={meta?.type ?? 'string'} value={cfg.value} />
                                  {meta?.unit && meta.type !== 'boolean' && (
                                    <span className="text-xs text-slate-400">{meta.unit}</span>
                                  )}
                                </>
                              )}
                            </div>
                          )}
                        </td>

                        {/* Last updated */}
                        <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap hidden md:table-cell">
                          {new Date(cfg.updatedAt).toLocaleString()}
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {isEditing ? (
                            <div className="flex items-center justify-end gap-3">
                              <button
                                onClick={() => save(cfg.key)}
                                disabled={savingKey === cfg.key}
                                className="text-xs font-semibold text-blue-600 hover:underline disabled:opacity-50"
                              >
                                {savingKey === cfg.key ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                onClick={() => cancelEdit(cfg.key)}
                                className="text-xs text-slate-400 hover:underline"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => startEdit(cfg.key, cfg.value)}
                              className="text-xs font-medium text-slate-500 hover:text-blue-600 hover:underline"
                            >
                              Edit
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
