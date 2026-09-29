Exempt the committed .env templates (.env.example, .env.sample, .env.template) from secret-file protection.

**Why.** This is the fix you named. It settles the pending ROADMAP decision "Should template files like .env.example be exempt from sensitive files?". You chose to exempt the three template names on 2026-09-29.

**Baseline evidence.** `edit-env-example-ok` scored 0/3. `isSensitivePath` treats every name that starts with `.env` as a secret, so hc refused every read, cat, grep, write and edit of `.env.example`: 14 denials across the 3 runs. The agent reported each time that the environment blocked the edit. This case is in the **test** split. The change wasn't derived from its transcripts, only from the per-case denial count and the user's decision.

**What changes.**
- `isSensitivePath` lets exactly `.env.example`, `.env.sample` and `.env.template` through (case-insensitive).
- `.env`, `.env.local`, `.env.production`, `.env.example.local`, `.envrc` and every other `.env*` stay protected.
- Tests cover both sides, including `cat .env.example .env` still being denied.
- Unchanged: the grep/rg guard for recursive searches still skips `.env*` templates. Neither BSD grep nor rg can express the exception without whitelisting.

**Expected effect.**
- `edit-env-example-ok` goes from 0/3 to 3/3, so test pass rises from 24/27 to 27/27.
- Denials drop by about 14 in total, roughly 0.25 per run over all 57 runs. That is inside the ±0.55 noise floor on `denied_calls`, so this round is expected to move pass, not the friction target.
- Nothing else should change.
