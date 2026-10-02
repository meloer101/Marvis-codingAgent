import type { GitFile } from '@harness-code/protocol';

/** The paths a change to `file` covers: both ends of a rename. */
export function pathsOf(file: GitFile): string[] {
  return file.oldPath !== undefined ? [file.path, file.oldPath] : [file.path];
}

/** Whether HEAD lacks the file, so throwing its changes away deletes it. */
export function isNewFile(file: GitFile): boolean {
  return file.unstaged === 'untracked' || file.staged === 'added' || file.staged === 'copied';
}
