export interface CommandSource {
  name: string;
  description: string;
  usage?: string;
  body: string;
}

export interface RoleSource {
  name: string;
  description: string;
  access: "read" | "write";
  body: string;
}

export interface AdapterSource {
  commands: CommandSource[];
  roles: RoleSource[];
  statusline: string;
}

export interface RenderedFile {
  path: string;
  content: string;
  mode?: number;
}

/**
 * A provider adapter turns the canonical source into provider-specific files.
 * `render` returns files that the harness owns entirely and hashes.
 * `merge` may adjust files shared with the user (settings) and must be idempotent.
 */
export interface MergeResult {
  files: string[];
  notes: string[];
}

export interface AdapterIssue {
  code: string;
  path: string;
  message: string;
}

export interface ProviderAdapter {
  id: string;
  /** default: installed by bootstrap; best-effort: opt-in with `--agents=`. */
  tier: "default" | "best-effort";
  render(source: AdapterSource): RenderedFile[];
  merge?(cwd: string): Promise<MergeResult>;
  /** Structural checks on shared files the adapter cannot hash (settings). */
  verify?(cwd: string): Promise<AdapterIssue[]>;
}
