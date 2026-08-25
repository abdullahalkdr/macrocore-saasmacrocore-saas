import { useEffect, useState } from 'react';
import { get, post, patch, del } from '../api/client';
import { useT } from '../i18n';
import { useLangStore } from '../store/langStore';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import { IconBell, IconApproval, IconTrash } from './Icon';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

// Visual polish pass — the redesign the user asked for ("مثل اشعار الايفون": clean,
// colored, with real detail) after the notify pipeline itself got fixed (see
// notifications.ts's notifyRoles() uuid/text bugfix — before that, this list was
// always empty in practice, so nobody had ever actually seen it rendered with real
// data). Two things changed here vs. before:
//   1. Every notification is bilingual in one DB column (MIGRATION_025 — "ar / en"
//      joined by " / ", never two separate columns) — this used to render both
//      halves squished together. localize() below picks just the half matching the
//      active UI language, same convention current_step_label already follows
//      elsewhere (ApprovalsInboxPage.tsx).
//   2. A colored icon badge per notification `type` (approval_pending -> the same
//      shield-check glyph the Approvals pages use, amber to match), a relative
//      "x minutes ago" timestamp instead of a raw locale string, and a clearer
//      unread state (tinted row + a small leading dot) instead of a flat list.
const TYPE_STYLE: Record<string, { icon: JSX.Element; color: string }> = {
  approval_pending: { icon: <IconApproval size={17} />, color: 'var(--amber-500)' },
};
const DEFAULT_TYPE_STYLE = { icon: <IconBell size={16} />, color: 'var(--stone-400)' };

// Bilingual strings from the backend are always "<arabic> / <english>" (one shared
// title/body column — see MIGRATION_025) — pick the half matching the active UI
// language. Falls back to the raw string untouched if there's no separator, so a
// future single-language notification type still renders fine.
function localize(value: string, lang: 'ar' | 'en'): string {
  const sep = value.indexOf(' / ');
  if (sep === -1) return value;
  const arPart = value.slice(0, sep).trim();
  const enPart = value.slice(sep + 3).trim();
  return lang === 'ar' ? arPart || value : enPart || value;
}

function timeAgo(iso: string, lang: 'ar' | 'en', t: ReturnType<typeof useT>): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return t.notifications.justNow;
  if (minutes < 60) return t.notifications.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.notifications.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return t.notifications.daysAgo(days);
  return new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar' : 'en', { day: 'numeric', month: 'short' });
}

export default function NotificationsBell() {
  const t = useT();
  const lang = useLangStore((s) => s.lang);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  function load() {
    get<{ notifications: NotificationItem[]; unread_count: number }>('/notifications')
      .then((r) => {
        setItems(r.notifications);
        setUnreadCount(r.unread_count);
      })
      .catch(() => {});
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, []);

  async function openPanel() {
    setOpen(true);
    load();
  }

  async function handleClick(n: NotificationItem) {
    if (!n.read_at) {
      await post(`/notifications/${n.id}/read`, {}).catch(() => {});
      load();
    }
    setOpen(false);
    if (n.link) navigate(n.link);
  }

  async function markAllRead() {
    await post('/notifications/read-all', {}).catch(() => {});
    load();
  }

  // Per-notification controls (MIGRATION_060) -- the user asked for a way to pick
  // exactly which notifications to clear instead of only "click one to navigate away"
  // or "mark literally everything read" via markAllRead above. stopPropagation on both
  // so they never also trigger the row's own onClick (handleClick, which navigates).
  const [deleteTarget, setDeleteTarget] = useState<NotificationItem | null>(null);

  async function toggleRead(n: NotificationItem, e: React.MouseEvent) {
    e.stopPropagation();
    await patch(`/notifications/${n.id}/read`, { read: !n.read_at }).catch(() => {});
    load();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    await del(`/notifications/${id}`).catch(() => {});
    load();
  }

  return (
    <>
      <button className="icon-btn" onClick={openPanel} title={t.notifications.title} style={{ position: 'relative', color: 'var(--stone-400)' }}>
        <IconBell />
        {unreadCount > 0 && (
          <span
            style={{
              position: 'absolute',
              top: -2,
              insetInlineEnd: -2,
              minWidth: 15,
              height: 15,
              padding: '0 4px',
              borderRadius: 999,
              background: '#dc2626',
              color: '#fff',
              fontSize: 9,
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1,
              boxShadow: '0 0 0 2px var(--surface)',
              animation: 'notif-badge-pop .25s ease-out',
            }}
          >
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <Modal
          title={t.notifications.title}
          onClose={() => setOpen(false)}
          actions={
            <button className="btn btn-secondary btn-sm" onClick={markAllRead} disabled={unreadCount === 0}>
              {t.notifications.markAllRead}
            </button>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto', margin: '-2px' }}>
            {items.map((n) => {
              const style = TYPE_STYLE[n.type] ?? DEFAULT_TYPE_STYLE;
              const unread = !n.read_at;
              return (
                <div
                  key={n.id}
                  onClick={() => handleClick(n)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '11px 12px',
                    borderRadius: 12,
                    border: `1px solid ${unread ? 'var(--amber-100)' : 'var(--border)'}`,
                    background: unread ? 'var(--amber-50)' : 'var(--surface)',
                    cursor: 'pointer',
                    position: 'relative',
                    transition: 'transform .12s ease, box-shadow .12s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow = '0 2px 10px rgba(0,0,0,.07)';
                    e.currentTarget.style.transform = 'translateY(-1px)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = 'none';
                    e.currentTarget.style.transform = 'none';
                  }}
                >
                  {/* Colored icon badge — a filled circle with a white glyph reads as a distinct
                      "kind" of notification at a glance, the same way an iOS notification's app
                      icon does, instead of every row looking identical. */}
                  <div
                    style={{
                      flex: '0 0 auto',
                      width: 34,
                      height: 34,
                      borderRadius: '50%',
                      background: style.color,
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {style.icon}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <div
                        style={{
                          fontWeight: unread ? 800 : 700,
                          fontSize: 13.5,
                          color: 'var(--text)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {localize(n.title, lang)}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', flex: '0 0 auto', whiteSpace: 'nowrap' }}>
                        {timeAgo(n.created_at, lang, t)}
                      </div>
                    </div>
                    {n.body && (
                      <div
                        style={{
                          fontSize: 12.5,
                          color: 'var(--muted)',
                          marginTop: 3,
                          lineHeight: 1.4,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {localize(n.body, lang)}
                      </div>
                    )}
                  </div>

                  {/* Per-item read/unread toggle + delete -- see toggleRead/confirmDelete
                      above. The dot itself IS the toggle button: filled amber while
                      unread, an empty ring once read, so selecting exactly which
                      notifications to clear doesn't require "mark all as read". */}
                  <div style={{ flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginTop: 2 }}>
                    <button
                      type="button"
                      onClick={(e) => toggleRead(n, e)}
                      title={unread ? t.notifications.markRead : t.notifications.markUnread}
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        border: unread ? 'none' : '2px solid var(--stone-300)',
                        background: unread ? 'var(--amber-500)' : 'transparent',
                        padding: 0,
                        cursor: 'pointer',
                      }}
                    />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(n);
                      }}
                      title={t.notifications.delete}
                      style={{ background: 'none', border: 'none', color: 'var(--stone-400)', padding: 0, cursor: 'pointer' }}
                    >
                      <IconTrash size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
            {items.length === 0 && (
              <div className="empty-state" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '28px 0' }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: 'var(--surface-alt)',
                    color: 'var(--stone-400)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <IconBell size={20} />
                </div>
                <div>{t.notifications.empty}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t.notifications.emptyHint}</div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title={t.notifications.delete}
          message={t.notifications.deleteConfirm}
          confirmLabel={t.notifications.delete}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
