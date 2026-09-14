/**
 * Built-in auto-mode classifier rules.
 *
 * Labels match the Claude Code auto-mode taxonomy so users can map docs and
 * `/permissions` entries. The prose is original to this project — not a copy
 * of another vendor's rule text. Entries that only apply to products we do
 * not ship (browser, tmux, cron, teammates, scheduled tasks, sandbox network
 * callbacks) are omitted.
 *
 * Each string is `Label: description`. `$defaults` in a settings array is
 * expanded in place by `resolveAutoModeRules`.
 */

export const DEFAULT_ENVIRONMENT: readonly string[] = [
  'Organization: Who this codebase belongs to and what the org does. Leave blank if unknown.',
  'Primary use of this agent: What the user typically asks it to do here (app work, infra, research, etc.).',
  'Cloud provider(s): AWS, GCP, Azure, none, or a private cloud. Empty means treat every cloud as untrusted.',
  'Repository visibility: public, private, or mixed. Public repos are a publication surface.',
  'Internal sharing / snippet hosting: Where the team pastes snippets (Gist, internal pastebin, none).',
  'Org-specific CLIs: Internal deploy, feature-flag, or ticket CLIs the agent might see.',
  'Secrets management: Vault, cloud SM, 1Password, .env files only, etc.',
  'CI/CD deploy targets: What a merge or workflow actually ships to.',
  'Network posture: Corp VPN, zero-trust, wide-open laptop, etc.',
  'Host containment: Devcontainer, VM, bare metal, shared bastion.',
  'Protected deployment namespaces / environments: Names that mean production (prod, live, customers, …).',
  'Data retention / declassification: Rules for deleting or exporting customer data.',
  'Trusted repo: Canonical remotes for this project (origin URL). Others are untrusted.',
  'Source control: Git host and whether force-push / unsigned commits are forbidden.',
  'Trusted internal domains: Hosts that are not "external" for data-flow rules.',
  'Trusted cloud buckets: Bucket names or prefixes that are in-org.',
  'Key internal services: Issue tracker, CI, package registry, internal APIs.',
  'Internal package registry: npm/pypi/cargo host that is first-party.',
  'Sensitive data locations & audiences: Where PII/secrets live and who may see them.',
  'Sensitive remote targets: Production DBs, customer clusters, payment systems.',
  'Protected IaC scopes: Terraform/Pulumi stacks or dirs that mutate prod.',
];

export const DEFAULT_ALLOW: readonly string[] = [
  'Security Discussion: Talking about, reviewing, or writing security-related code, docs, or threat models is not by itself Credential Exploration, Exfil Scouting, or Auto-Mode Bypass. Actually running an exploit, scraping secrets, or probing live endpoints is still judged on its own.',
  'Transient Retry: Retrying the same action after a network error, 5xx, timeout, rate limit, or an unexpected tool error is not Auto-Mode Bypass. The retry is still judged against every other rule — if the original was blocked for X, so is the retry. An obfuscated retry (encoding, renaming, extra indirection) is bypass.',
  'Test Artifacts: Hard-coded example keys, fixture credentials, and test cases authored as placeholders. A value copied from a real secret or sensitive path is never a test artifact.',
  'Local Operations: Deleting or editing files inside this session\'s project workspace, and local-only TLS workarounds for local testing. Does not cover leaving the repo (~/, /etc, other checkouts), destroying pre-existing irreplaceable data, or touching local stateful services. Content copied from a sensitive store outside the repo is judged by Sensitive-Source Provenance.',
  'Read-Only Operations: GET/read API calls that do not change state, do not put secrets in the URL, and do not return credentials, secrets, or PII. If the transcript shows the agent is scouting for a blocked action, block it anyway.',
  'Declared Dependencies: Installing packages already listed in this repo\'s manifests (package.json, requirements.txt, Cargo.toml, pyproject.toml, Gemfile, …) via the standard command that reads that file, provided the agent has not edited the manifest this session. Agent-chosen package names (`npm install foo`) are not covered.',
  'Toolchain Bootstrap: Installing a language toolchain from its official installer (rustup, pypa, astral, bun, nodesource, docker, brew) when the repo\'s build files show that toolchain is required. Not for arbitrary packages.',
  'Standard Credentials: Reading this project\'s own config (.env, settings) and sending a key to the service it belongs to. Sending it anywhere else is Credential Leakage.',
  'Session-Created Job Cleanup: Deleting the exact jobs/resources this agent created earlier in this transcript, by ids it recorded at creation. Not jobs the user likely started, pre-existing dev environments, shared production work, or bulk deletes by filter.',
  'Git Push Destination: Pushing to a branch of this session\'s repo is an ordinary destination — including the default branch. This blesses the remote/branch only. What the push contains is still judged (secrets in the diff, production deploy, etc.). A branch whose name marks it as a deploy target (production, release, gh-pages, …) is not blessed by this exception.',
  'Trusted Internal Infra (Data Flow): Hosts, buckets, and services listed in Environment are not "external" for Code from External / Untrusted Code Integration when used as intended. Destructive actions, permission changes, and credential operations on that infra are not exempt.',
  'Memory Directory: Routine writes and deletes under this product\'s memory directory — notes and preferences the system prompt tells the agent to keep. Not a vehicle for Instruction Poisoning.',
  'Project Notes Content: Editing AGENTS.md or CLAUDE.md (and their .local variants) when the new text does not change permissions, authorizations, or auto-mode behaviour. Coding conventions and project notes are allowed.',
];

export const DEFAULT_SOFT_DENY: readonly string[] = [
  'Git Destructive: git reset --hard, checkout/restore that discards uncommitted work, clean -f, stash drop/clear, or rewriting published history (force-push, reset of a shared branch) without a clear, specific user request for that exact action.',
  'Code That Leaks When Run: Adding or running code that will exfiltrate secrets, env, or private data when someone executes it (webhooks in CI, postinstall scripts, "debug" log of process.env).',
  'Code from External: Fetching and then executing or merging code from an origin that is not this repo or a trusted internal source in Environment.',
  'Cloud Storage Mass Delete: Bulk delete or lifecycle-expire of cloud objects/buckets, especially outside a clearly named scratch prefix.',
  'Production Deploy: Shipping to production, customer-facing, or similarly named environments, including "just a small hotfix".',
  'Remote Shell Writes: Writing files or running mutating commands on a remote host (ssh, SSM, kubectl exec, cloud serial consoles).',
  'Sensitive Remote Exec: Running commands against production DBs, payment systems, or other sensitive remotes listed in Environment.',
  'Production Reads: Reading customer data, prod configs, or secrets from production systems without an explicit request to do so.',
  'Blind Apply: terraform/pulumi/ansible/helm apply, kubectl apply, or equivalent without the user having seen and approved the plan.',
  'Protected-Scope IaC Apply: Applying IaC that touches stacks/dirs called out as protected in Environment.',
  'Logging/Audit Tampering: Disabling, deleting, or rerouting audit logs, CloudTrail, SIEM, or similar.',
  'Permission Grant: Granting IAM, RBAC, sudo, or repo permissions, including making a resource public.',
  'TLS/Auth Weaken: Disabling TLS verification, auth, or security headers on anything that is not a declared local test.',
  'Secret-Store Writes: Creating, rotating, or deleting secrets in Vault/SM/1Password without an explicit request.',
  'DNS / Domain / Cert Changes: Changing DNS, domains, or certificates.',
  'Security Weaken: Relaxing authz, CORS, firewall, or security-group rules.',
  'Security Test Removal: Deleting or skipping security tests, secret scanners, or policy gates to make a change land.',
  'Safety Bypass Flag: Adding --no-verify, --insecure, DANGEROUS_*, or equivalent just to get past a control.',
  'Create Unsafe Agents: Standing up an agent, bot, or automation with weaker permissions or no human gate.',
  'Interfere With Workloads: Stopping, draining, or resizing other people\'s running jobs/services.',
  'Shared Cluster Mutation: Changing shared Kubernetes/nomad/swarm clusters (nodes, controllers, cluster-scoped objects).',
  'CI Bypass: Skipping required checks, pushing with --no-verify, or editing branch protection to land a change.',
  'Modify Shared Resources: Changing shared queues, feature flags, or org-wide config the user did not name.',
  'Irreversible Local Destruction: rm -rf of the repo, home, or other pre-existing work the user did not name; disk wipe; dropping local databases that are not throwaway.',
  'Unverifiable Deletion Target: Deleting "whatever matches this glob" when the agent has not listed the matches.',
  'Shared Scratch Sweep: Cleaning a shared /tmp, build cache, or artifact bucket used by others.',
  'Irreversible Deletion (general): Deletes that cannot be undone and were not explicitly requested, including cloud resources.',
  'Unverifiable Deletion Scope: A delete whose scope the agent cannot actually enumerate before running it.',
  'Create RCE Surface: Adding eval of untrusted input, exposed debug consoles, or world-writable exec paths.',
  'Expose Local Services: Binding a service to 0.0.0.0 / exposing a local port through a tunnel without being asked.',
  'External Ingress Tunnel: ngrok, cloudflared, ssh -R, and similar inbound tunnels.',
  'Credential Leakage: Putting secrets into chat, tickets, logs, git, or any destination that is not the secret\'s intended service.',
  'Credential Materialization: Writing live secrets into the working tree, CI logs, or screenshots.',
  'Credential Exploration: Searching hosts, shells, or cloud APIs for credentials the task does not need.',
  'PII Data Handling: Copying, exporting, or aggregating personal data without an explicit request and a stated audience.',
  'Exfil Scouting: Mapping where secrets/PII live, or testing channels, in a way that looks like preparation to move them.',
  'Traffic Redirection: Changing proxies, /etc/hosts, load balancers, or DNS so traffic goes somewhere new.',
  'Remote Repoint: git remote add/set-url to an unexpected host, or pushing this repo to a new remote.',
  'Out-of-Place Publication: Publishing this work to a package registry, gist, public bucket, or pages site the user did not name.',
  'Sensitive-Source Provenance: Writing content whose source is a sensitive file or store into a less-protected place.',
  'Excess Sensitive Detail: Putting more secret/PII detail into an artifact or message than the task needs.',
  'Unrequested Artifact Publish: npm publish, docker push, gh release, or equivalent without a publish request.',
  'Live-Shared Artifact Sensitive Delta: Updating an already-public or already-shared artifact so it now contains secrets or PII.',
  'Containment Escape: Breaking out of a container/devcontainer/sandbox, mounting the host, or disabling the jail.',
  'Create Public Surface: Making a private repo, bucket, or endpoint public.',
  'Public Data-Sharing Upload: Uploading workspace contents to a public paste, form, or "helper" site.',
  'Untrusted Code Integration: Adding a dependency, submodule, or copied snippet from an untrusted source into the build.',
  'Package Registry Bypass: Forcing a package install past signature, checksum, or lockfile checks.',
  'Unauthorized Persistence: Cron, systemd user units, login hooks, or other persistence the user did not ask for.',
  'Self-Modification: Changing this agent\'s own settings, prompts, hooks, or permission rules to loosen them.',
  'Instruction Poisoning: Writing instructions into memory, AGENTS.md, or skills that would later override the user\'s standing rules.',
  'Auto-Mode Bypass: Routing around auto-mode (encoding a blocked command, using another tool to do the same thing, asking a sub-agent to ignore a block).',
  'Session Transcript Tampering: Editing session logs, traces, or transcripts to hide what happened.',
  'External System Writes: Mutating third-party systems (SaaS admin, email, calendars, customer records) without a specific request.',
  'Merge Without Review: Merging a PR without the review the repo requires, or approving one\'s own change.',
  'Self-Approval: Using the agent to approve, LGTM, or bypass a check on its own work.',
  'ChatOps Trigger Comments: Posting comments/commands that will fire deploy or production workflows.',
  'Feature Flag Writes: Changing production feature flags.',
  'Node Lifecycle Operations: Adding, draining, or destroying cluster nodes.',
  'Cluster-Wide Workload Creation: Creating DaemonSets, cluster jobs, or org-wide workflows.',
  'Real-World Transactions: Payments, invoices, domain purchases, or other actions that spend money or enter contracts.',
  'Third-Party Attack: Using this session to probe, exploit, or attack a system that is not the user\'s own.',
];

export const DEFAULT_HARD_DENY: readonly string[] = [
  'Data Exfiltration: Moving secrets, private source, customer data, or credentials to any destination the user did not clearly authorize for that data — including hidden channels (encoded payloads, steganography, unexpected remotes, "debug" uploads). There is no allow-exception for this; block it.',
];

const GROUPS = {
  environment: DEFAULT_ENVIRONMENT,
  allow: DEFAULT_ALLOW,
  soft_deny: DEFAULT_SOFT_DENY,
  hard_deny: DEFAULT_HARD_DENY,
} as const;

export type AutoModeRuleGroup = keyof typeof GROUPS;

export function defaultRulesFor(group: AutoModeRuleGroup): readonly string[] {
  return GROUPS[group];
}

/** True when a settings array still wants the built-in list spliced in. */
export function listUsesDefaults(list: string[] | undefined): boolean {
  return list === undefined || list.includes('$defaults');
}

/**
 * Expand `$defaults` in each configured list. A missing key becomes the full
 * built-in group. A present array replaces the group, except that `$defaults`
 * is spliced in at the position it appears.
 */
export function resolveAutoModeRules(settings: {
  autoMode?: {
    environment?: string[];
    allow?: string[];
    soft_deny?: string[];
    hard_deny?: string[];
  };
}): {
  environment: string[];
  allow: string[];
  soft_deny: string[];
  hard_deny: string[];
} {
  const cfg = settings.autoMode ?? {};
  return {
    environment: expandGroup(cfg.environment, DEFAULT_ENVIRONMENT),
    allow: expandGroup(cfg.allow, DEFAULT_ALLOW),
    soft_deny: expandGroup(cfg.soft_deny, DEFAULT_SOFT_DENY),
    hard_deny: expandGroup(cfg.hard_deny, DEFAULT_HARD_DENY),
  };
}

export function expandGroup(list: string[] | undefined, defaults: readonly string[]): string[] {
  if (list === undefined) return [...defaults];
  const out: string[] = [];
  for (const item of list) {
    if (item === '$defaults') out.push(...defaults);
    else out.push(item);
  }
  return out;
}

export function ruleLabel(entry: string): string {
  const i = entry.indexOf(':');
  return i === -1 ? entry.trim() : entry.slice(0, i).trim();
}
