import type { Account } from "./contracts";

/** The sole addressing name; the original name is never an alias. */
export function accountName(account: Pick<Account, "name" | "nickname">): string {
  return account.nickname?.trim() || account.name.trim();
}

export function speakerLabel(nickname: string, name?: string | null): string {
  return name && name !== nickname ? `${nickname} (${name})` : nickname;
}
