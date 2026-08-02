import { useEffect, useState } from 'react';
import { get, post } from '../api/client';
import { useT } from '../i18n';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import { IconBell } from './Icon';

interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export default function NotificationsBell() {
  const t = useT();
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 400, overflowY: 'auto' }}>
            {items.map((n) => (
              <div
                key={n.id}
                onClick={() => handleClick(n)}
                style={{
                  padding: '10px 12px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: n.read_at ? 'transparent' : 'var(--surface-alt)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 13 }}>{n.title}</div>
                {n.body && <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{n.body}</div>}
                <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>{new Date(n.created_at).toLocaleString()}</div>
              </div>
            ))}
            {items.length === 0 && <div className="empty-state">{t.notifications.empty}</div>}
          </div>
        </Modal>
      )}
    </>
  );
}
