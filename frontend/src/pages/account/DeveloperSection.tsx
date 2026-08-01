import { FormEvent, useEffect, useState } from 'react';
import { get, post, del, ApiError } from '../../api/client';
import { useT } from '../../i18n';

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export default function DeveloperSection() {
  const t = useT();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    get<{ api_keys: ApiKey[] }>('/api-keys')
      .then((r) => setKeys(r.api_keys))
      .catch((err) => setError(err instanceof ApiError ? err.message : t.account.loadFailed));
  }

  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      const res = await post<{ key: string }>('/api-keys', { name });
      setJustCreated(res.key);
      setName('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    }
  }

  async function handleRevoke(id: string) {
    try {
      await del(`/api-keys/${id}`);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.account.saveFailed);
    }
  }

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="card">
        <div className="card-body">
          <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
            {t.account.developer.hint}
          </p>
          <form onSubmit={handleCreate} className="form-row">
            <div className="field" style={{ flex: 2 }}>
              <input placeholder={t.account.developer.keyName} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <button className="btn btn-primary btn-sm" type="submit">
              {t.account.developer.createKey}
            </button>
          </form>

          {justCreated && (
            <div className="success-banner">
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{t.account.developer.keyCreatedTitle}</div>
              <code style={{ display: 'block', background: '#fff', padding: '8px 10px', borderRadius: 8, fontSize: 13, wordBreak: 'break-all' }}>
                {justCreated}
              </code>
              <div style={{ fontSize: 11, marginTop: 6 }}>{t.account.developer.keyCreatedHint}</div>
            </div>
          )}

          {keys.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>
              {t.account.developer.empty}
            </p>
          ) : (
            <table className="table" style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th>{t.account.developer.keyName}</th>
                  <th>{t.account.developer.lastUsed}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>
                      {k.name}
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        <code>{k.key_prefix}••••</code>
                      </div>
                    </td>
                    <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : t.account.developer.never}</td>
                    <td>
                      {k.revoked_at ? (
                        <span className="badge closed">{t.account.developer.revoked}</span>
                      ) : (
                        <button className="btn btn-secondary btn-sm" onClick={() => handleRevoke(k.id)}>
                          {t.account.developer.revoke}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
