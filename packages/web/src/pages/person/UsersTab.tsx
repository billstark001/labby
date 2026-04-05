import { useEffect, useState } from 'preact/hooks';
import { apiClient } from '@/lib/api';
import { i18n } from '@/i18n';
import * as s from '@/styles/components.css';
import { Button } from '@/components/ui';
import { Dialog, confirmDialog } from '@/components/ui/Dialog';
import { toast } from '@/components/ui/Toast';

interface SafeUser {
  id: string;
  username: string;
  email?: string;
  role: number;
  disabled: boolean;
  createdAt: number;
}

interface UsersTabProps {
  canManageUsers: boolean;
}

function roleLabel(role: number): string {
  const { t } = i18n;
  if (role === 2) return t('userRoleRoot');
  if (role === 1) return t('userRoleAdmin');
  return t('userRoleUser');
}

interface CreateUserFormProps {
  onSave: () => void;
  onCancel: () => void;
}

function CreateUserForm({ onSave, onCancel }: CreateUserFormProps) {
  const { t } = i18n;
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(0);

  async function handleSubmit() {
    try {
      await apiClient.request('/users', {
        method: 'POST',
        body: JSON.stringify({ username, email: email || undefined, password, role }),
      });
      toast.success(t('createUser'));
      onSave();
    } catch (err) {
      toast.error(String(err));
    }
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('username')}</label>
        <input class={s.input} value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('email')}</label>
        <input class={s.input} type="email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('password')}</label>
        <input class={s.input} type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('userRole')}</label>
        <select class={s.input} value={role} onChange={(e) => setRole(Number((e.target as HTMLSelectElement).value))}>
          <option value={0}>{t('userRoleUser')}</option>
          <option value={1}>{t('userRoleAdmin')}</option>
        </select>
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={() => void handleSubmit()}>{t('save')}</Button>
        <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}

interface EditUserFormProps {
  user: SafeUser;
  onSave: () => void;
  onCancel: () => void;
}

function EditUserForm({ user, onSave, onCancel }: EditUserFormProps) {
  const { t } = i18n;
  const [role, setRole] = useState(user.role);
  const [disabled, setDisabled] = useState(user.disabled);

  async function handleSubmit() {
    try {
      await apiClient.request(`/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role, disabled }),
      });
      toast.success(t('editUser'));
      onSave();
    } catch (err) {
      toast.error(String(err));
    }
  }

  return (
    <div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('username')}</label>
        <input class={s.input} value={user.username} disabled />
      </div>
      <div class={s.formGroup}>
        <label class={s.label}>{t('userRole')}</label>
        <select class={s.input} value={role} onChange={(e) => setRole(Number((e.target as HTMLSelectElement).value))}>
          <option value={0}>{t('userRoleUser')}</option>
          <option value={1}>{t('userRoleAdmin')}</option>
        </select>
      </div>
      <div class={s.formGroup}>
        <label class={s.flexGapSm}>
          <input
            type="checkbox"
            checked={disabled}
            onChange={(e) => setDisabled((e.target as HTMLInputElement).checked)}
          />
          {t('userDisabled')}
        </label>
      </div>
      <div class={s.flexGapSm}>
        <Button variant="primary" onClick={() => void handleSubmit()}>{t('save')}</Button>
        <Button variant="secondary" onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </div>
  );
}

export function UsersTab({ canManageUsers }: UsersTabProps) {
  const { t } = i18n;
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingUser, setEditingUser] = useState<SafeUser | null>(null);

  async function loadUsers() {
    setLoading(true);
    try {
      const data = await apiClient.request<SafeUser[]>('/users');
      setUsers(data);
    } catch (err) {
      toast.error(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, []);

  function handleDelete(user: SafeUser) {
    confirmDialog(t('deleteUser'), t('deleteUserWarning'), async () => {
      try {
        await apiClient.request(`/users/${user.id}`, { method: 'DELETE' });
        await loadUsers();
      } catch (err) {
        toast.error(String(err));
      }
    });
  }

  if (loading) {
    return <div class={`${s.text14} ${s.textMuted}`}>{t('serverCapabilitiesLoading')}</div>;
  }

  return (
    <div>
      <div class={`${s.toolbar} ${s.mb24}`}>
        <Button variant="primary" onClick={() => setShowCreateDialog(true)}>
          + {t('createUser')}
        </Button>
      </div>

      <table class={s.table}>
        <thead>
          <tr>
            <th class={s.th}>{t('username')}</th>
            <th class={s.th}>{t('email')}</th>
            <th class={s.th}>{t('userRole')}</th>
            <th class={s.th}>{t('userDisabled')}</th>
            <th class={s.th}></th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id}>
              <td class={s.td}>{user.username}</td>
              <td class={s.td}>{user.email ?? '—'}</td>
              <td class={s.td}>{roleLabel(user.role)}</td>
              <td class={s.td}>{user.disabled ? '✓' : '—'}</td>
              <td class={s.td}>
                <div class={s.flexGapSm}>
                  {user.role < 2 && (
                    <Button variant="ghost" onClick={() => setEditingUser(user)}>
                      {t('editUser')}
                    </Button>
                  )}
                  {canManageUsers && user.role < 2 && (
                    <Button variant="danger" onClick={() => handleDelete(user)}>
                      {t('deleteUser')}
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {showCreateDialog && (
        <Dialog open={true} onClose={() => setShowCreateDialog(false)} title={t('createUser')}>
          <CreateUserForm
            onSave={async () => {
              setShowCreateDialog(false);
              await loadUsers();
            }}
            onCancel={() => setShowCreateDialog(false)}
          />
        </Dialog>
      )}

      {editingUser && (
        <Dialog open={true} onClose={() => setEditingUser(null)} title={t('editUser')}>
          <EditUserForm
            user={editingUser}
            onSave={async () => {
              setEditingUser(null);
              await loadUsers();
            }}
            onCancel={() => setEditingUser(null)}
          />
        </Dialog>
      )}
    </div>
  );
}
