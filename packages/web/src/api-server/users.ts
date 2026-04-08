import { apiClient } from "@/lib/api";


export const USER_ROLE_USER = 0;
export const USER_ROLE_ADMIN = 1;
export const USER_ROLE_ROOT = 2;

export type UserRole = typeof USER_ROLE_USER | typeof USER_ROLE_ADMIN | typeof USER_ROLE_ROOT;
export type UserRoleWithoutRoot = typeof USER_ROLE_USER | typeof USER_ROLE_ADMIN;

export interface SafeUser {
  id: string;
  username: string;
  email?: string;
  role: UserRole;
  disabled: boolean;
  createdAt: number;
}

export async function createUser(
  username: string,
  email: string,
  password: string,
  role: UserRoleWithoutRoot,
) {
  return await apiClient.request<void>('/users', {
    method: 'POST',
    body: JSON.stringify({ username, email: email || undefined, password, role }),
  });
}

export async function updateUser(
  id: string,
  updates: Partial<Pick<SafeUser, 'username' | 'email' | 'role' | 'disabled'>>,
) {
  return await apiClient.request<void>(`/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
}

export async function deleteUser(id: string) {
  return await apiClient.request<void>(`/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function fetchUsers(): Promise<SafeUser[]> {
  return await apiClient.request<SafeUser[]>('/users', {
    method: 'GET',
  });
}
