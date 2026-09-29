# user-dedupe

Finds user accounts that were created more than once with the same email
address. The nightly cleanup job calls `findDuplicateEmails(rows)` on the full
user table and merges each reported group into its oldest account.

```js
import { findDuplicateEmails } from './src/dedupe.js';

findDuplicateEmails([
  { id: 1, email: 'ann@example.com' },
  { id: 2, email: 'ben@example.com' },
  { id: 3, email: 'Ann+shop@example.com' },
]);
// -> [[0, 2]]
```

- `npm test` — unit tests
- `npm run bench [-- <count>]` — times `findDuplicateEmails` on a generated
  user table (20 000 users by default)
